// @ts-check
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { resolveKiroPaths, userDataDirFromGlobalStorage } = require('./core/paths');
const { Ingestor } = require('./core/ingest');
const { buildPayload, buildStatusData, buildExportContent } = require('./core/views');
const { SessionStatusBar } = require('./statusBar');
const { DashboardPanel } = require('./panel');
const i18n = require('../media/i18n');

const QUOTA_INTERVAL_MS = 60_000;
const PANEL_NOTIFY_MIN_MS = 5_000;
const PRUNE_INTERVAL_MS = 3_600_000;
const DB_FILE = 'toys-for-kiro.db';
const EXTENSION_ID = 'moluogh.toys-for-kiro';

function openSettings() {
  return vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_ID}`);
}

/** True for plain option bags, excluding `vscode.Uri` passed by editor/title menus. @param {unknown} v */
function isPlainOptions(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v) && !('scheme' in v) && !('fsPath' in v));
}

/** @returns {import('./core/views').Settings & { storageMode: 'disk' | 'memory', retentionDays: number, statusBarEnabled: boolean, statusBarMode: 'session' | 'today' | 'cycle', refreshIntervalSeconds: number, lang: 'zh' | 'en' }} */
function readSettings() {
  const c = vscode.workspace.getConfiguration('toysForKiro');
  const windows = c.get('modelContextWindows', {});
  const rawMode = String(c.get('statusBar.mode', 'session'));
  const statusBarMode = rawMode === 'today' || rawMode === 'cycle' ? rawMode : 'session';
  return {
    contextWindowTokens: Number(c.get('contextWindowTokens', 1_000_000)) || 1_000_000,
    modelContextWindows: windows && typeof windows === 'object' ? /** @type {Record<string, number>} */ (windows) : {},
    creditPriceUsd: Number(c.get('creditPriceUsd', 0)) || 0,
    importLegacySessions: c.get('importLegacySessions', true) !== false,
    defaultRange: String(c.get('defaultRange', 'cycle')),
    storageMode: c.get('storage.mode', 'disk') === 'memory' ? 'memory' : 'disk',
    retentionDays: Math.max(0, Math.floor(Number(c.get('storage.retentionDays', 0)) || 0)),
    statusBarEnabled: c.get('statusBar.enabled', true) !== false,
    statusBarMode,
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
    const data = buildStatusData(this.store, this.settings, folders);
    this.statusBar.update(data, this.settings.lang, this.settings.statusBarMode);
  }

  /** @param {any} msg */
  buildPayload(msg) {
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    return buildPayload(msg, { store: this.store, settings: this.settings, workspaceFolders });
  }

  /**
   * Prompt for export target and destination file, then write CSV or JSON.
   * @param {{ target?: 'requests-csv' | 'sessions-csv' | 'daily-csv' | 'report-json', view?: string, range?: string | null, filters?: any, sessionQuery?: string, sessionWorkspaceOnly?: boolean }} [opts]
   */
  async exportData(opts = {}) {
    /** @type {Array<{ id: 'requests-csv' | 'sessions-csv' | 'daily-csv' | 'report-json', label: string, description: string, slug: string }>} */
    const allChoices = [
      { id: 'requests-csv', label: this.t('export.requestsCsv'), description: this.t('export.requestsDesc'), slug: 'requests' },
      { id: 'sessions-csv', label: this.t('export.sessionsCsv'), description: this.t('export.sessionsDesc'), slug: 'sessions' },
      { id: 'daily-csv', label: this.t('export.dailyCsv'), description: this.t('export.dailyDesc'), slug: 'daily' },
      { id: 'report-json', label: this.t('export.reportJson'), description: this.t('export.reportDesc'), slug: 'report' },
    ];
    let chosen = opts.target ? allChoices.find((c) => c.id === opts.target) : undefined;
    if (!chosen) {
      const preferred = opts.view === 'sessions' ? 'sessions-csv' : opts.view === 'quota' ? 'daily-csv' : 'requests-csv';
      const ordered = [...allChoices.filter((c) => c.id === preferred), ...allChoices.filter((c) => c.id !== preferred)];
      chosen = await vscode.window.showQuickPick(ordered, { placeHolder: this.t('export.placeholder') });
    }
    if (!chosen) return undefined;

    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const out = buildExportContent(
      {
        target: chosen.id,
        range: opts.range ?? null,
        filters: opts.filters,
        sessionQuery: opts.sessionQuery,
        sessionWorkspaceOnly: opts.sessionWorkspaceOnly,
        unlinkedTitle: this.t('session.legacyUnlinked'),
      },
      { store: this.store, settings: this.settings, workspaceFolders },
    );
    const d = new Date();
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const filename = `kiro-usage-${chosen.slug}-${stamp}.${out.ext}`;
    const baseDir = workspaceFolders[0] || os.homedir();
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(baseDir, filename)),
      filters: out.ext === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
    });
    if (!uri) return undefined;
    try {
      await fsp.writeFile(uri.fsPath, out.content, 'utf8');
    } catch (e) {
      this.log.error(e instanceof Error ? e : String(e));
      void vscode.window.showErrorMessage(this.t('msg.exportFailed', { e: e instanceof Error ? e.message : String(e) }));
      return undefined;
    }
    void vscode.window.showInformationMessage(this.t('msg.exported', { f: path.basename(uri.fsPath) }));
    return uri.fsPath;
  }

  /** Wait for any in-flight work, then start a scan without dropping `opts`. @param {{ legacy?: boolean, force?: boolean }} opts */
  async runScan(opts) {
    while (this.running) await this.running.catch(() => {});
    if (this.disposed) return;
    await this.tick(opts);
  }

  fullScan() {
    return this.runScan({ legacy: this.settings.importLegacySessions, force: true });
  }

  async refresh() {
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
    }
    if (prev.defaultRange !== this.settings.defaultRange) {
      DashboardPanel.current?.post({ type: 'navigate', range: this.settings.defaultRange });
    }
    if (prev.storageMode !== this.settings.storageMode) {
      await this.switchStorage(this.settings.storageMode);
      return;
    }
    this.updateStatusBar();
    const legacy = !prev.importLegacySessions && this.settings.importLegacySessions;
    await this.runScan({ legacy, force: true });
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
  const log = vscode.window.createOutputChannel('Kiro Usage', { log: true });
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
    exportData: (/** @type {any} */ m) => app.exportData(m),
    openSettings: () => openSettings(),
    defaultRange: () => app.settings.defaultRange,
    lang: () => app.settings.lang,
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('toysForKiro.openDashboard', (/** @type {any} */ opts) => {
      DashboardPanel.show(context, host, isPlainOptions(opts) ? opts : {});
    }),
    vscode.commands.registerCommand('toysForKiro.exportData', (/** @type {any} */ opts) => {
      if (isPlainOptions(opts)) return app.exportData(opts);
      const panel = DashboardPanel.current;
      return app.exportData(panel ? { view: panel.activeView, range: panel.activeRange } : {});
    }),
    vscode.commands.registerCommand('toysForKiro.openSettings', () => openSettings()),
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
