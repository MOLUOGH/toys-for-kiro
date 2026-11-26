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

const QUOTA_INTERVAL_MS = 60_000;
const PANEL_NOTIFY_MIN_MS = 5_000;
const PRUNE_INTERVAL_MS = 3_600_000;
const DB_FILE = 'toys-for-kiro.db';

/** @returns {import('./core/views').Settings & { storageMode: 'disk' | 'memory', retentionDays: number, statusBarEnabled: boolean, refreshIntervalSeconds: number }} */
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
    this.statusBar.update(session ? { ...sessionStats(this.store, this.settings, session), storage: this.settings.storageMode } : null);
  }

  /** @param {any} msg */
  buildPayload(msg) {
    return buildPayload(msg, { store: this.store, settings: this.settings });
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
        void vscode.window.showErrorMessage(`Toys for Kiro 无法打开本地索引，已改用内存模式：${e instanceof Error ? e.message : e}`);
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
      const pick = await vscode.window.showInformationMessage(
        'Toys for Kiro 已切换到内存模式，不再写入磁盘。之前保存的本地索引还在磁盘上，要删除吗？',
        '删除',
        '保留',
      );
      if (pick === '删除') await this.clearData();
    }
  }

  async onSettingsChanged() {
    const prev = this.settings;
    this.settings = readSettings();
    if (prev.refreshIntervalSeconds !== this.settings.refreshIntervalSeconds) this.schedule();
    if (prev.storageMode !== this.settings.storageMode) {
      await this.switchStorage(this.settings.storageMode);
      return;
    }
    const legacy = !prev.importLegacySessions && this.settings.importLegacySessions;
    await this.exclusive(() => {});
    await this.tick({ legacy, force: true });
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.statusBar.dispose();
    this.store.close();
  }
}

/** @param {'none' | 'deleted' | 'cleared'} result @param {'disk' | 'memory'} mode */
function clearMessage(result, mode) {
  const rebuilt = mode === 'disk' ? '已从 Kiro 现有文件重新生成。' : '';
  if (result === 'none') return mode === 'disk' ? `磁盘上没有旧索引。${rebuilt}` : '磁盘上没有 Toys for Kiro 的本地索引。';
  if (result === 'cleared') return `本地索引已清空（另一个 Kiro 窗口正在使用该文件，无法直接删除）。${rebuilt}`;
  return `已删除本地索引。${rebuilt}`;
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
    void vscode.window.showErrorMessage(`Toys for Kiro 无法打开本地索引（需要 Node 22.13+ 的 node:sqlite）：${e instanceof Error ? e.message : e}`);
    return undefined;
  }

  const app = new App(context, store, log, settings);
  const host = {
    buildPayload: (/** @type {any} */ m) => app.buildPayload(m),
    refresh: () => app.refresh(),
    defaultRange: () => app.settings.defaultRange,
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('toysForKiro.openDashboard', (/** @type {any} */ opts) => {
      DashboardPanel.show(context, host, opts && typeof opts === 'object' ? opts : {});
    }),
    vscode.commands.registerCommand('toysForKiro.refresh', () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Toys for Kiro：扫描本地数据' }, () => app.refresh()),
    ),
    vscode.commands.registerCommand('toysForKiro.rebuildIndex', async () => {
      const ok = await vscode.window.showWarningMessage(
        '重新解析全部会话？已采集的请求日志会保留（Kiro 已删除的旧日志无法恢复）。',
        { modal: true },
        '重建',
      );
      if (ok !== '重建') return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Toys for Kiro：重建索引' }, () => app.rebuild());
    }),
    vscode.commands.registerCommand('toysForKiro.clearData', async () => {
      const mode = app.settings.storageMode;
      if (mode === 'memory' && !app.diskIndexExists()) {
        void vscode.window.showInformationMessage(clearMessage('none', mode));
        return 'none';
      }
      const detail =
        mode === 'disk'
          ? '删除后会从 Kiro 现有的会话和日志重新生成。Kiro 已删除的旧日志里的延迟和错误记录会永久丢失。Kiro 自己的会话和日志不受影响。'
          : '删除磁盘上残留的索引文件。当前内存里的统计不受影响。';
      const ok = await vscode.window.showWarningMessage('删除 Toys for Kiro 的本地索引？', { modal: true, detail }, '删除');
      if (ok !== '删除') return undefined;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Toys for Kiro：清除本地数据' }, () => app.clearData());
      void vscode.window.showInformationMessage(clearMessage(result, mode));
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
