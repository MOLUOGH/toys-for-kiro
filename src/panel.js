// @ts-check
'use strict';

const vscode = require('vscode');
const crypto = require('crypto');

/**
 * @typedef {{ view?: string, range?: string | null, sessionId?: string | null }} OpenOptions
 * @typedef {{ buildPayload: (msg: any) => any, refresh: () => Promise<void>, exportData: (opts?: any) => Promise<any>, openSettings: () => Promise<any>, defaultRange: () => string, lang: () => 'zh' | 'en' }} PanelHost
 */

class DashboardPanel {
  /** @type {DashboardPanel | null} */
  static current = null;

  /**
   * @param {vscode.ExtensionContext} context
   * @param {PanelHost} host
   * @param {OpenOptions} [opts]
   */
  static show(context, host, opts = {}) {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      if (opts.view || opts.range || opts.sessionId) {
        DashboardPanel.current.post({
          type: 'navigate',
          view: opts.view ?? null,
          range: opts.range ?? null,
          sessionId: opts.sessionId ?? null,
        });
      }
      return DashboardPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('toysForKiro.dashboard', 'Kiro Usage', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    DashboardPanel.current = new DashboardPanel(panel, context, host, opts);
    return DashboardPanel.current;
  }

  /**
   * @param {vscode.WebviewPanel} panel
   * @param {vscode.ExtensionContext} context
   * @param {PanelHost} host
   * @param {OpenOptions} opts
   */
  constructor(panel, context, host, opts) {
    this.panel = panel;
    this.host = host;
    this.initial = opts;
    this.activeView = opts.view || 'overview';
    this.activeRange = opts.range ?? null;
    this.dirty = false;
    /** @type {vscode.Disposable[]} */
    this.disposables = [];
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(context);
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch(() => {}), null, this.disposables);
    panel.onDidChangeViewState(() => {
      if (panel.visible && this.dirty) this.notifyChanged();
    }, null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** @param {any} msg */
  post(msg) {
    void this.panel.webview.postMessage(msg);
  }

  /** @param {'zh' | 'en'} lang */
  setLang(lang) {
    this.post({ type: 'lang', lang });
  }

  /** Data changed on disk: ask the webview to reload its current view. */
  notifyChanged() {
    if (!this.panel.visible) {
      this.dirty = true;
      return;
    }
    this.dirty = false;
    this.post({ type: 'changed' });
  }

  /** @param {any} m */
  async onMessage(m) {
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'ready':
        this.post({
          type: 'init',
          lang: this.host.lang(),
          defaultRange: this.host.defaultRange(),
          view: this.initial.view ?? null,
          range: this.initial.range ?? null,
          sessionId: this.initial.sessionId ?? null,
        });
        break;
      case 'load':
        try {
          const view = String(m.view || 'overview');
          const range = typeof m.range === 'string' ? m.range : null;
          this.activeView = view;
          this.activeRange = view === 'quota' ? 'cycle' : range;
          const payload = this.host.buildPayload({
            view,
            range,
            filters: m.filters && typeof m.filters === 'object' ? m.filters : {},
            sessionId: typeof m.sessionId === 'string' ? m.sessionId : null,
          });
          this.post({ type: 'data', seq: m.seq, view: m.view, payload });
        } catch (e) {
          this.post({ type: 'error', seq: m.seq, message: e instanceof Error ? e.message : String(e) });
        }
        break;
      case 'refresh':
        await this.host.refresh();
        this.post({ type: 'changed' });
        break;
      case 'export':
        await this.host.exportData(m);
        break;
      case 'settings':
        await this.host.openSettings();
        break;
      default:
        break;
    }
  }

  /** @param {vscode.ExtensionContext} context */
  html(context) {
    const webview = this.panel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    const media = (/** @type {string} */ f) => webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', f));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${this.host.lang() === 'en' ? 'en' : 'zh-CN'}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('dashboard.css')}">
<title>Kiro Usage</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${media('i18n.js')}"></script>
<script nonce="${nonce}" src="${media('dashboard.js')}"></script>
</body>
</html>`;
  }

  dispose() {
    DashboardPanel.current = null;
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

module.exports = { DashboardPanel };
