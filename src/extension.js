// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { resolveKiroPaths, userDataDirFromGlobalStorage } = require('./core/paths');
const { Ingestor } = require('./core/ingest');
const { buildPayload, findActiveSession, sessionStats } = require('./core/views');
const { SessionStatusBar } = require('./statusBar');
const { DashboardPanel } = require('./panel');
const i18n = require('../media/i18n');

const QUOTA_INTERVAL_MS = 60_000;
const PANEL_NOTIFY_MIN_MS = 5_000;
const PRUNE_INTERVAL_MS = 3_600_000;
const DB_FILE = 'toys-for-kiro.db';

/** @returns {import('./core/views').Settings & { storageMode: 'disk' | 'memory', retentionDays: number, statusBarEnabled: boolean, refreshIntervalSeconds: number, lang: 'zh' | 'en' }} */
function readSettings() {
  const c = vscode.workspace.getConfiguration('toysForKiro');
  const windows = c.get('modelContextWindows', {});
  return {
    contextWindowTokens: Number(c.get('contextWindowTokens', 1_000_000)) || 1_000_000,
    modelContextWindows: windows && typeof windows === 'object' ? /** @type {Record<string, number>} */ (windows) : {},
    creditPriceUsd: Number(c.get('creditPriceUsd', 0)) || 0,
    importLegacySessions: c.get('importLegacySessions', true) !== false,
    defaultRange: String(c.get('defaultRange', 'cycle')),
    storageMode: c.get('storage.mode', 'disk') === 'memory' ? 'memory' : 'disk',
    retentionDays: Math.max(0, Math.floor(Number(c.get('storage.retentionDays', 0)) || 0)),
    statusBarEnabled: c.get('statusBar.enabled', true) !== false,
    refreshIntervalSeconds: Math.min(300, Math.max(2, Number(c.get('refreshIntervalSeconds', 5)) || 5)),
    lang: i18n.resolveLang(String(c.get('language', 'auto')), vscode.env?.language),
  };
}

/** @param {vscode.ExtensionContext} context */
function dbPathFor(context) {
  return path.join(context.globalStorageUri.fsPath, DB_FILE);
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {'disk' | 'memory'} mode
 */
function openStore(context, mode) {
  const { Store, MEMORY } = require('./core/store');
  if (mode === 'memory') return new Store(MEMORY);
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  return new Store(dbPathFor(context));
}

class App {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./core/store').Store} store
   * @param {vscode.LogOutputChannel} log
   * @param {ReturnType<typeof readSettings>} settings
   */
  constructor(context, store, log, settings) {
    this.context = context;
    this.store = store;
    this.log = log;
    this.settings = settings;
    const paths = resolveKiroPaths({ userDataDir: userDataDirFromGlobalStorage(context.globalStorageUri.fsPath) });
    log.info(`Kiro data: sessions=${paths.sessionsDir} logs=${paths.logsDir}; storage=${settings.storageMode}`);
    this.ingestor = new Ingestor({ store, paths, log: (m) => log.warn(m) });
    this.statusBar = new SessionStatusBar();
    /** @type {Promise<any> | null} */
    this.running = null;
    this.lastQuotaAt = 0;
    this.lastPanelNotify = 0;
    this.lastPruneAt = 0;
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined;
    this.disposed = false;
  }

  start() {
    this.ready = this.tick({ legacy: this.settings.importLegacySessions, force: true });
    this.schedule();
    return this.ready;
  }

  schedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick({}), this.settings.refreshIntervalSeconds * 1000);
  }

  /**
   * Run `fn` while no scan is in progress, and block scans until it finishes.
   * @template T @param {() => Promise<T> | T} fn @returns {Promise<T>}
   */
  async exclusive(fn) {
    while (this.running) await this.running.catch(() => {});
    const p = (async () => fn())();
    this.running = p;
    try {
      return await p;
    } finally {
      if (this.running === p) this.running = null;
    }
  }

  /** @param {{ legacy?: boolean, force?: boolean }} opts */
  tick(opts) {
    if (this.running) return this.running;
    const p = (async () => {
      try {
        const now = Date.now();
        const quota = opts.force || now - this.lastQuotaAt >= QUOTA_INTERVAL_MS;
        if (quota) this.lastQuotaAt = now;
        const r = await this.ingestor.run({ legacy: opts.legacy, quota });
        if (this.settings.retentionDays > 0 && (opts.force || now - this.lastPruneAt >= PRUNE_INTERVAL_MS)) {
          this.lastPruneAt = now;
          if (this.ingestor.prune(this.settings.retentionDays, now) > 0) r.changed = true;
        }
        if (this.disposed) return;
        if (r.changed || opts.force) {
          this.updateStatusBar();
          this.notifyPanel(!!opts.force);
        }
      } catch (e) {
        this.log.error(e instanceof Error ? e : String(e));
      }
    })();
    this.running = p;
    void p.finally(() => {
      if (this.running === p) this.running = null;
    });
    return p;
  }

  /** @param {boolean} immediate */
  notifyPanel(immediate) {
    const panel = DashboardPanel.current;
    if (!panel) return;
    const now = Date.now();
    if (!immediate && now - this.lastPanelNotify < PANEL_NOTIFY_MIN_MS) return;
    this.lastPanelNotify = now;
    panel.notifyChanged();
  }

  updateStatusBar() {
    if (!this.settings.statusBarEnabled) {
      this.statusBar.hide();
      return;
    }
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const session = findActiveSession(this.store, folders);
    this.statusBar.update(session ? { ...sessionStats(this.store, this.settings, session), storage: this.settings.storageMode } : null, this.settings.lang);
  }

  /** @param {any} msg */
  buildPayload(msg) {
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    return buildPayload(msg, { store: this.store, settings: this.settings, workspaceFolders });
  }

  fullScan() {
    return this.tick({ legacy: this.settings.importLegacySessions, force: true });
  }

  async refresh() {
    await this.exclusive(() => {});
    await this.fullScan();
  }

  async rebuild() {
    await this.exclusive(() => this.store.resetDerived());
    await this.fullScan();
  }

  /** @param {import('./core/store').Store} store */
  setStore(store) {
    this.store = store;
    this.ingestor.store = store;
    this.ingestor.logFiles = null;
    this.lastPruneAt = 0;
  }

  /**
   * Close the current store and open a new one in `mode`. Falls back to an
   * in-memory store if the file cannot be opened.
   * @param {'disk' | 'memory'} mode
   * @param {() => void} [beforeOpen] runs after the old store is closed
   */
  reopen(mode, beforeOpen) {
    this.store.close();
    try {
      if (beforeOpen) beforeOpen();
    } finally {
      try {
        this.setStore(openStore(this.context, mode));
      } catch (e) {
        this.log.error(e instanceof Error ? e : String(e));
        void vscode.window.showErrorMessage(this.t('msg.memoryFallback', { e: e instanceof Error ? e.message : e }));
        this.setStore(openStore(this.context, 'memory'));
      }
    }
  }

  diskIndexExists() {
    const { Store } = require('./core/store');
    return Store.exists(dbPathFor(this.context));
  }

  /**
   * Delete the on-disk index. In disk mode it is rebuilt from Kiro's current files.
   * @returns {Promise<'none' | 'deleted' | 'cleared'>}
   */
  async clearData() {
    const { Store } = require('./core/store');
    const file = dbPathFor(this.context);
    /** @type {'none' | 'deleted' | 'cleared'} */
    let result = 'none';
    await this.exclusive(() => {
      if (this.store.inMemory) {
        result = Store.wipe(file);
      } else {
        this.reopen('disk', () => {
          result = Store.wipe(file);
        });
      }
    });
    await this.fullScan();
    return result;
  }

  /** @param {'disk' | 'memory'} mode */
  async switchStorage(mode) {
    await this.exclusive(() => this.reopen(mode));
    this.log.info(`storage=${mode}`);
    await this.fullScan();
    if (mode === 'memory' && vscode.window.state?.focused !== false && this.diskIndexExists()) {
      const del = this.t('msg.delete');
      const pick = await vscode.window.showInformationMessage(this.t('msg.switchedToMemory'), del, this.t('msg.keep'));
      if (pick === del) await this.clearData();
    }
  }

  async onSettingsChanged() {
    const prev = this.settings;
    this.settings = readSettings();
    if (prev.refreshIntervalSeconds !== this.settings.refreshIntervalSeconds) this.schedule();
    if (prev.lang !== this.settings.lang) {
      DashboardPanel.current?.setLang(this.settings.lang);
      this.updateStatusBar();
    }
    if (prev.storageMode !== this.settings.storageMode) {
      await this.switchStorage(this.settings.storageMode);
      return;
    }
    const legacy = !prev.importLegacySessions && this.settings.importLegacySessions;
    await this.exclusive(() => {});
    await this.tick({ legacy, force: true });
  }

  /** @param {string} key @param {Record<string, unknown>} [params] */
  t(key, params) {
    return i18n.t(this.settings.lang, key, params);
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.statusBar.dispose();
    this.store.close();
  }
}

/** @param {App} app @param {'none' | 'deleted' | 'cleared'} result @param {'disk' | 'memory'} mode */
function clearMessage(app, result, mode) {
  const rebuilt = mode === 'disk' ? app.t('msg.rebuilt') : '';
  if (result === 'none') return mode === 'disk' ? app.t('msg.noneDisk', { rebuilt }) : app.t('msg.noneMemory');
  return app.t(result === 'cleared' ? 'msg.cleared' : 'msg.deleted', { rebuilt });
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const log = vscode.window.createOutputChannel('Toys for Kiro', { log: true });
  context.subscriptions.push(log);

  const settings = readSettings();
  /** @type {import('./core/store').Store} */
  let store;
  try {
    store = openStore(context, settings.storageMode);
  } catch (e) {
    log.error(e instanceof Error ? e : String(e));
    void vscode.window.showErrorMessage(i18n.t(settings.lang, 'msg.openFailed', { e: e instanceof Error ? e.message : e }));
    return undefined;
  }

  const app = new App(context, store, log, settings);
  const host = {
    buildPayload: (/** @type {any} */ m) => app.buildPayload(m),
    refresh: () => app.refresh(),
    defaultRange: () => app.settings.defaultRange,
    lang: () => app.settings.lang,
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('toysForKiro.openDashboard', (/** @type {any} */ opts) => {
      DashboardPanel.show(context, host, opts && typeof opts === 'object' ? opts : {});
    }),
    vscode.commands.registerCommand('toysForKiro.refresh', () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: app.t('msg.scanning') }, () => app.refresh()),
    ),
    vscode.commands.registerCommand('toysForKiro.rebuildIndex', async () => {
      const rebuild = app.t('msg.rebuild');
      const ok = await vscode.window.showWarningMessage(app.t('msg.rebuildConfirm'), { modal: true }, rebuild);
      if (ok !== rebuild) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: app.t('msg.rebuilding') }, () => app.rebuild());
    }),
    vscode.commands.registerCommand('toysForKiro.clearData', async () => {
      const mode = app.settings.storageMode;
      if (mode === 'memory' && !app.diskIndexExists()) {
        void vscode.window.showInformationMessage(clearMessage(app, 'none', mode));
        return 'none';
      }
      const detail = app.t(mode === 'disk' ? 'msg.clearDetailDisk' : 'msg.clearDetailMemory');
      const del = app.t('msg.delete');
      const ok = await vscode.window.showWarningMessage(app.t('msg.clearConfirm'), { modal: true, detail }, del);
      if (ok !== del) return undefined;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: app.t('msg.clearing') }, () => app.clearData());
      void vscode.window.showInformationMessage(clearMessage(app, result, mode));
      return result;
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('toysForKiro')) void app.onSettingsChanged();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => app.updateStatusBar()),
    { dispose: () => app.dispose() },
  );

  const ready = app.start();
  return { app, ready };
}

function deactivate() {}

module.exports = { activate, deactivate };
