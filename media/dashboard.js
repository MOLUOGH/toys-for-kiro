// @ts-check
/* global acquireVsCodeApi */
(function () {
  'use strict';

  // @ts-ignore provided by the webview host
  const vscode = acquireVsCodeApi();
  /** @type {{ t: (lang: string, key: string, params?: Record<string, unknown>) => string }} */
  const I18N = /** @type {any} */ (globalThis).KT_I18N;
  const root = /** @type {HTMLElement} */ (document.getElementById('root'));
  const saved = vscode.getState() || {};
  const state = {
    view: saved.view || 'overview',
    range: saved.range || null,
    metric: saved.metric || 'tokens',
    filters: saved.filters || {},
    sessionId: saved.sessionId || null,
    sessionQuery: typeof saved.sessionQuery === 'string' ? saved.sessionQuery : '',
    sessionWorkspaceOnly: !!saved.sessionWorkspaceOnly,
    // The panel HTML carries the language; the extension also sends it with 'init'.
    lang: saved.lang || (document.documentElement && document.documentElement.lang === 'en' ? 'en' : 'zh'),
    /** @type {any} */ data: null,
    dataView: null,
    lastJson: '',
    error: '',
    seq: 0,
  };

  /** @param {string} key @param {Record<string, unknown>} [params] */
  const t = (key, params) => I18N.t(state.lang, key, params);

  const VIEWS = ['overview', 'requests', 'sessions', 'quota'];
  const RANGES = ['cycle', 'today', '24h', '7d', '30d', 'all'];
  const OUTCOMES = ['ok', 'error', 'cancelled', 'unknown'];

  // ---------- formatting ----------
  /** @param {unknown} s */
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  /** @param {number | null | undefined} n */
  const ok = (n) => n != null && Number.isFinite(n);
  /** @param {number | null | undefined} n */
  function compact(n, d = 2) {
    if (!ok(n)) return '—';
    const v = /** @type {number} */ (n);
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(d) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(d) + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  }
  /** @param {number | null | undefined} n */
  const int = (n) => (ok(n) ? Math.round(/** @type {number} */ (n)).toLocaleString('en-US') : '—');
  /** @param {number | null | undefined} n */
  const cr = (n) => (ok(n) ? (/** @type {number} */ (n) >= 100 ? /** @type {number} */ (n).toFixed(1) : /** @type {number} */ (n).toFixed(2)) : '—');
  /** @param {number | null | undefined} n */
  const usd = (n) => (ok(n) ? '$' + (/** @type {number} */ (n) >= 100 ? /** @type {number} */ (n).toFixed(0) : /** @type {number} */ (n).toFixed(2)) : '—');
  /** @param {number | null | undefined} n */
  const pct = (n, d = 1) => (ok(n) ? /** @type {number} */ (n).toFixed(d) + '%' : '—');
  /** @param {number | null | undefined} ms */
  function dur(ms) {
    if (!ok(ms)) return '—';
    const v = /** @type {number} */ (ms);
    if (v < 1000) return Math.round(v) + 'ms';
    const s = v / 1000;
    if (s < 60) return s.toFixed(1) + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + Math.round(s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }
  /** @param {number | null | undefined} n */
  const speed = (n) => (ok(n) ? /** @type {number} */ (n).toFixed(/** @type {number} */ (n) >= 100 ? 0 : 1) + ' tok/s' : '—');
  /** @param {number} n */
  const pad = (n) => String(n).padStart(2, '0');
  /** @param {number | string | null | undefined} t0 */
  function md(t0) {
    if (t0 == null) return '—';
    const d = new Date(t0);
    return d.getMonth() + 1 + '/' + d.getDate();
  }
  /** @param {number | string | null | undefined} t0 */
  function mdhm(t0) {
    if (t0 == null) return '—';
    const d = new Date(t0);
    return md(t0) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  /** @param {number | string | null | undefined} t0 */
  function full(t0) {
    if (t0 == null) return '';
    const d = new Date(t0);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  /** Billing dates are UTC calendar dates, as Kiro shows them. @param {number | string | null | undefined} t0 */
  function utcMd(t0) {
    if (t0 == null) return '—';
    const d = new Date(t0);
    return d.getUTCMonth() + 1 + '/' + d.getUTCDate();
  }
  /** "11/25", or "2027/11/25" when not in the current year. @param {number | string} t0 @param {number} now */
  function ymd(t0, now) {
    const d = new Date(t0);
    return d.getFullYear() === new Date(now).getFullYear() ? md(t0) : `${d.getFullYear()}/${md(t0)}`;
  }
  /** @param {number} t0 */
  const hm = (t0) => {
    const d = new Date(t0);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  };
  /** Distribution labels starting with "@" are translation keys. @param {string} label */
  const label = (label) => (label.startsWith('@') ? t('dist.' + label) : label);
  /** @param {string} id @param {string | null | undefined} title */
  const titleOf = (id, title) => title || (id === 'legacy:unlinked' ? t('session.legacyUnlinked') : id);

  // ---------- state & messaging ----------
  function persist() {
    vscode.setState({
      view: state.view,
      range: state.range,
      metric: state.metric,
      filters: state.filters,
      sessionId: state.sessionId,
      sessionQuery: state.sessionQuery,
      sessionWorkspaceOnly: state.sessionWorkspaceOnly,
      lang: state.lang,
    });
  }

  /** @param {string | undefined} lang */
  function setLang(lang) {
    if (lang !== 'en' && lang !== 'zh') return;
    state.lang = lang;
    if (document.documentElement) document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  }

  function load() {
    state.seq++;
    persist();
    vscode.postMessage({ type: 'load', seq: state.seq, view: state.view, range: state.range, filters: state.filters, sessionId: state.sessionId });
    if (state.dataView !== state.view) {
      state.data = null;
      render();
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    switch (m.type) {
      case 'init':
        setLang(m.lang);
        if (m.range) state.range = m.range;
        else if (!state.range) state.range = m.defaultRange || 'cycle';
        if (m.view) state.view = m.view;
        if (m.sessionId) state.sessionId = m.sessionId;
        load();
        break;
      case 'lang':
        setLang(m.lang);
        persist();
        render();
        break;
      case 'navigate':
        state.view = m.view || state.view;
        if (m.range) state.range = m.range;
        if (m.sessionId) state.sessionId = m.sessionId;
        load();
        break;
      case 'data': {
        if (m.seq !== state.seq) return;
        const json = JSON.stringify(m.payload);
        if (json === state.lastJson && state.dataView === m.view && !state.error) return;
        state.lastJson = json;
        state.data = m.payload;
        state.dataView = m.view;
        state.error = '';
        render();
        break;
      }
      case 'error':
        if (m.seq && m.seq !== state.seq) return;
        state.error = m.message || t('common.unknownError');
        render();
        break;
      case 'changed':
        load();
        break;
      default:
        break;
    }
  });

  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('[data-action]') : null;
    if (!target) return;
    const el = /** @type {HTMLElement} */ (target);
    switch (el.dataset.action) {
      case 'view':
        state.view = el.dataset.view || 'overview';
        load();
        break;
      case 'refresh':
        vscode.postMessage({ type: 'refresh' });
        break;
      case 'export':
        vscode.postMessage({
          type: 'export',
          view: state.view,
          range: state.view === 'quota' ? 'cycle' : state.range,
          filters: state.view === 'requests' ? state.filters : undefined,
          sessionQuery: state.view === 'sessions' ? state.sessionQuery : undefined,
          sessionWorkspaceOnly: state.view === 'sessions' ? state.sessionWorkspaceOnly : undefined,
        });
        break;
      case 'settings':
        vscode.postMessage({ type: 'settings' });
        break;
      case 'metric':
        state.metric = el.dataset.value || 'tokens';
        persist();
        render();
        break;
      case 'session':
        state.sessionId = el.dataset.id || null;
        state.view = 'sessions';
        load();
        break;
      case 'close-session':
        state.sessionId = null;
        load();
        break;
      default:
        break;
    }
  });

  document.addEventListener('change', (e) => {
    const el = /** @type {HTMLSelectElement & HTMLInputElement} */ (e.target);
    const key = el && el.dataset ? el.dataset.change : null;
    if (!key) return;
    if (key === 'session-ws') {
      state.sessionWorkspaceOnly = !!el.checked;
      persist();
      render();
      return;
    }
    if (key === 'range') state.range = el.value;
    else state.filters = Object.assign({}, state.filters, { [key]: el.value || undefined });
    load();
  });

  document.addEventListener('input', (e) => {
    const el = /** @type {HTMLInputElement} */ (e.target);
    if (!el || !el.dataset || el.dataset.input !== 'session-query') return;
    state.sessionQuery = el.value || '';
    persist();
    render();
  });

  // ---------- rendering ----------
  function render() {
    const active = /** @type {any} */ (document).activeElement;
    const keepFocus = active && active.dataset && active.dataset.input === 'session-query';
    const selStart = keepFocus ? active.selectionStart : null;
    const selEnd = keepFocus ? active.selectionEnd : null;
    const d = state.data;
    let body;
    if (state.error) body = `<div class="empty error">${esc(state.error)}</div>`;
    else if (!d || state.dataView !== state.view) body = `<div class="empty">${esc(t('common.loading'))}</div>`;
    else if (state.view === 'requests') body = renderRequests(d);
    else if (state.view === 'sessions') body = renderSessions(d);
    else if (state.view === 'quota') body = renderQuota(d);
    else body = renderOverview(d);
    root.innerHTML = header() + `<main>${body}</main>`;
    if (keepFocus && typeof document.querySelector === 'function') {
      const input = /** @type {HTMLInputElement | null} */ (document.querySelector('[data-input="session-query"]'));
      if (input) {
        input.focus();
        if (selStart != null && selEnd != null) input.setSelectionRange(selStart, selEnd);
      }
    }
  }

  const BRAND_ICON =
    '<svg class="brand-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><defs><linearGradient id="ku-b-bg" x1="2" y1="1" x2="22" y2="23" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#9B4DFF"/><stop offset="52%" stop-color="#782CE3"/><stop offset="100%" stop-color="#451294"/></linearGradient><linearGradient id="ku-b-rim" x1="1" y1="1" x2="21" y2="22" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.35"/><stop offset="55%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient><linearGradient id="ku-b-arc" x1="3.5" y1="16.2" x2="19.3" y2="6.7" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#34D399"/><stop offset="52%" stop-color="#38BDF8"/><stop offset="100%" stop-color="#FCD34D"/></linearGradient></defs><rect width="24" height="24" rx="5.5" fill="url(#ku-b-bg)"/><rect x="0.5" y="0.5" width="23" height="23" rx="5" stroke="url(#ku-b-rim)"/><path d="M 3.51 16.18 A 9.3 9.3 0 1 1 20.98 9.99" stroke="#FFFFFF" stroke-opacity="0.2" stroke-width="1.8" stroke-linecap="round"/><path d="M 3.51 16.18 A 9.3 9.3 0 0 1 19.33 6.67" stroke="url(#ku-b-arc)" stroke-width="1.9" stroke-linecap="round"/><circle cx="19.33" cy="6.67" r="0.62" fill="#FFFFFF"/><path d="M 10.45 6.45 C 12.85 6.45, 14.0 8.5, 14.0 11.45 C 14.0 15.2, 13.5 19.5, 11.95 19.5 C 11.1 19.5, 10.7 18.6, 10.45 17.75 C 10.0 18.8, 9.2 19.5, 8.15 19.5 C 6.85 19.5, 6.45 17.7, 6.85 16.15 C 6.05 16.35, 5.65 15.85, 5.75 14.9 C 5.85 13.95, 6.55 12.9, 6.8 11.05 C 7.1 8.25, 8.3 6.45, 10.45 6.45 Z" fill="#FFFFFF"/><ellipse cx="10.5" cy="11.0" rx="0.6" ry="1.32" fill="#1F0842"/><ellipse cx="12.5" cy="11.0" rx="0.6" ry="1.32" fill="#1F0842"/><rect x="16.0" y="16.0" width="1.15" height="3.5" rx="0.55" fill="#34D399"/><rect x="18.0" y="14.0" width="1.15" height="5.5" rx="0.55" fill="#38BDF8"/><rect x="20.0" y="11.8" width="1.15" height="7.7" rx="0.55" fill="#FCD34D"/></svg>';
  const ICON_EXPORT =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const ICON_REFRESH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><polyline points="21 3 21 8 16 8"/></svg>';
  const ICON_SETTINGS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

  function header() {
    const tabs = VIEWS.map((k) => `<button class="tab${state.view === k ? ' active' : ''}" data-action="view" data-view="${k}">${esc(t('view.' + k))}</button>`).join('');
    const range =
      state.view === 'quota'
        ? ''
        : `<select class="range" data-change="range" title="${esc(t('range.title'))}">${RANGES.map((k) => `<option value="${k}"${state.range === k ? ' selected' : ''}>${esc(t('range.' + k))}</option>`).join('')}</select>`;
    return `<header class="top"><div class="brand">${BRAND_ICON}<span>Kiro Usage</span></div><nav class="tabs">${tabs}</nav><div class="grow"></div>${range}<button class="icon-btn" data-action="export" title="${esc(t('common.export'))}" aria-label="${esc(t('common.export'))}">${ICON_EXPORT}</button><button class="icon-btn" data-action="refresh" title="${esc(t('common.refresh'))}" aria-label="${esc(t('common.refresh'))}">${ICON_REFRESH}</button><button class="icon-btn" data-action="settings" title="${esc(t('common.settings'))}" aria-label="${esc(t('common.settings'))}">${ICON_SETTINGS}</button></header>`;
  }

  /** @param {any} r */
  function caption(r) {
    const memory =
      state.data && state.data.meta && state.data.meta.storage === 'memory'
        ? ` · <span title="${esc(t('caption.memoryNote'))}">${esc(t('caption.memory'))}</span>`
        : '';
    const name = esc(t(r.label || 'range.' + r.key));
    const now = esc(t('common.now'));
    if (r.utc) {
      const reset = r.resetAt ? t('caption.resets', { d: utcMd(r.resetAt) }) : '';
      return `<div class="caption" title="${esc(t('utcNote'))}">${name} · ${esc(utcMd(r.from))} – ${now}${esc(reset)}${memory}</div>`;
    }
    return `<div class="caption">${name} · ${esc(mdhm(r.from))} – ${now}${memory}</div>`;
  }

  /** @param {string} msg */
  const empty = (msg) => `<div class="empty">${esc(msg)}</div>`;

  /** @param {number[]} values */
  function spark(values) {
    const W = 200;
    const H = 36;
    const max = Math.max(0, ...values);
    if (!values.length || max <= 0) return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><line class="spark-base" x1="0" y1="${H - 1}" x2="${W}" y2="${H - 1}" vector-effect="non-scaling-stroke"/></svg>`;
    const n = values.length;
    const pts = values.map((v, i) => [(i / (n - 1 || 1)) * W, H - 2 - (v / max) * (H - 6)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="spark-area" d="${line} L${W} ${H} L0 ${H} Z"/><path class="spark-line" d="${line}" vector-effect="non-scaling-stroke"/></svg>`;
  }

  /** @param {string} title @param {string} value @param {string} sub @param {string} note @param {string} chart */
  function card(title, value, sub, note, chart) {
    return `<div class="card"><div class="card-title">${esc(title)}</div><div class="card-value">${value}</div><div class="card-sub">${sub}</div>${
      note ? `<div class="card-note">${esc(note)}</div>` : ''
    }${chart}</div>`;
  }

  /** @param {string} action @param {string} current @param {string[][]} options */
  function segmented(action, current, options) {
    return `<div class="seg">${options.map(([k, l]) => `<button class="${current === k ? 'active' : ''}" data-action="${action}" data-value="${k}">${esc(l)}</button>`).join('')}</div>`;
  }

  const DAY_MS = 86400000;

  /** @param {number} unit */
  function unitLabel(unit) {
    if (unit >= DAY_MS) return t('unit.day', { n: Math.round(unit / DAY_MS) });
    if (unit >= 3600000) return t('unit.hour', { n: unit / 3600000 });
    return t('unit.min', { n: unit / 60000 });
  }

  /** @param {any} h @param {string} metric */
  function heatmap(h, metric) {
    let max = 0;
    for (const col of h.cells) for (const c of col) if (c && c[metric] > max) max = c[metric];
    const daily = h.unit >= DAY_MS;
    /** @param {any} c */
    const cell = (c) => {
      if (!c) return '<div class="hm-cell out"></div>';
      const v = c[metric];
      const lv = v > 0 && max > 0 ? Math.max(1, Math.ceil(Math.sqrt(v / max) * 4)) : 0;
      const when = daily ? md(c.t0) : `${md(c.t0)} ${hm(c.t0)}–${hm(c.t1)}`;
      const tip = `${when}\n${t('heatmap.tip', { r: int(c.requests), t: compact(c.tokens), c: cr(c.credits) })}`;
      return `<div class="hm-cell l${lv}" title="${esc(tip)}"></div>`;
    };
    const grid = h.cells.map((/** @type {any[]} */ col) => col.map(cell).join('')).join('');

    // Axis labels, spaced so they do not overlap. Windows up to 36 h are labelled
    // by time of day, longer ones by date.
    const byTime = h.end - h.start <= 36 * 3600000;
    const gap = byTime ? 6 : 5;
    let lastCol = -gap;
    let lastDay = '';
    const axis = h.colStarts
      .map((/** @type {number} */ t0, /** @type {number} */ i) => {
        let text = '';
        if (byTime) {
          if (i - lastCol >= gap) text = hm(t0);
        } else {
          const day = md(t0);
          if (day !== lastDay && i - lastCol >= gap) text = day;
          if (text) lastDay = day;
        }
        if (text) lastCol = i;
        return `<div class="hm-axis">${esc(text)}</div>`;
      })
      .join('');
    const legend = [0, 1, 2, 3, 4].map((l) => `<span class="hm-cell l${l}"></span>`).join('');
    const foot = t(daily ? 'heatmap.footDaily' : 'heatmap.footTime', { u: unitLabel(h.unit) });
    return `<div class="heatmap" style="--cols:${h.cols}"><div class="hm-grid">${grid}</div><div class="hm-axis-row">${axis}</div></div>
<div class="hm-foot"><span>${esc(foot)}</span><span class="hm-legend">${esc(t('heatmap.less'))}${legend}${esc(t('heatmap.more'))}</span></div>`;
  }

  /** @param {any} h */
  function health(h) {
    if (!h.models.length) return empty(t('health.empty'));
    const rows = h.models
      .map((/** @type {any} */ m) => {
        const cells = m.buckets
          .map((/** @type {any} */ b, /** @type {number} */ i) => {
            let cls = 'none';
            if (b.total) {
              const judged = b.ok + b.error;
              const rate = judged ? b.ok / judged : null;
              cls = rate == null ? 'neutral' : rate === 1 ? 'good' : rate >= 0.9 ? 'warn' : 'bad';
            }
            const from = t('health.from', { t: mdhm(h.from + i * h.bucketMs) });
            const tip = `${from}\n${b.total ? t('health.tip', { ok: b.ok, e: b.error, c: b.cancelled }) : t('health.none')}`;
            return `<span class="hl-cell ${cls}" title="${esc(tip)}"></span>`;
          })
          .join('');
        return `<div class="hl-name" title="${esc(m.model)}">${esc(m.model)}</div><div class="hl-bar">${cells}</div><div class="hl-rate">${m.rate == null ? '—' : pct(m.rate * 100, 0)}</div>`;
      })
      .join('');
    return `<div class="health">${rows}</div>`;
  }

  /** @param {Array<{label: string, value: number}>} items @param {string} center @param {string} unit @param {(n: number) => string} fmt */
  function donut(items, center, unit, fmt) {
    const total = items.reduce((s, x) => s + x.value, 0);
    const R = 46;
    const C = 2 * Math.PI * R;
    let off = 0;
    const segs =
      total > 0
        ? items
            .map((x, i) => {
              const len = (x.value / total) * C;
              const s = `<circle class="seg-arc s${i % 7}" r="${R}" cx="60" cy="60" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 60 60)"/>`;
              off += len;
              return s;
            })
            .join('')
        : '';
    const legend = items.length
      ? items
          .map((x, i) => {
            const name = label(x.label);
            return `<li><span class="sw s${i % 7}"></span><span class="lg-name" title="${esc(name)}">${esc(name)}</span><span class="lg-val">${esc(fmt(x.value))}</span><span class="lg-pct">${total > 0 ? pct((x.value / total) * 100) : '—'}</span></li>`;
          })
          .join('')
      : `<li class="muted">${esc(t('common.noData'))}</li>`;
    return `<div class="donut"><svg viewBox="0 0 120 120"><circle class="donut-track" r="${R}" cx="60" cy="60"/>${segs}<text x="60" y="60" class="donut-value">${esc(center)}</text><text x="60" y="76" class="donut-unit">${esc(unit)}</text></svg><ul class="legend">${legend}</ul></div>`;
  }

  /** @param {any} d */
  function renderOverview(d) {
    const tt = d.totals;
    const status =
      `<span class="dot good"></span>${esc(t('overview.okCount', { n: int(tt.ok) }))} <span class="dot bad"></span>${esc(t('overview.errorCount', { n: int(tt.errors) }))}` +
      (tt.cancelled ? ` <span class="dot neutral"></span>${esc(t('overview.cancelCount', { n: int(tt.cancelled) }))}` : '');
    const tokenSub = esc(t('overview.tokenSub', { i: compact(tt.inputTokens), o: compact(tt.outputTokens) }));
    const tokenNote = t('overview.tokenNote', { w: compact(d.meta.window, 0) }) + (tt.legacyRequests ? t('overview.legacyNote', { n: tt.legacyRequests }) : '');
    const creditSub = esc(t('overview.creditSub', { usd: usd(tt.usd), avg: cr(tt.avgCredits) }));
    return `${caption(d.range)}
<section class="cards">
${card(t('overview.requests'), int(tt.requests), status, tt.avgTtftMs != null ? t('overview.avgTtft', { d: dur(tt.avgTtftMs) }) : '', spark(d.spark.requests))}
${card(t('overview.tokens'), compact(tt.inputTokens + tt.outputTokens), tokenSub, tokenNote, spark(d.spark.tokens))}
${card(t('overview.credits'), cr(tt.credits), creditSub, t('overview.priceNote', { p: d.meta.price }), spark(d.spark.credits))}
</section>
<section class="panel"><div class="panel-head"><h2>${esc(t('heatmap.title'))}</h2>${segmented('metric', state.metric, [
      ['tokens', t('heatmap.tokens')],
      ['requests', t('heatmap.requests')],
      ['credits', t('heatmap.credits')],
    ])}</div>${heatmap(d.heatmap, state.metric)}</section>
<section class="panel"><div class="panel-head"><h2>${esc(t('health.title'))}</h2><span class="muted">${d.health.overall == null ? '' : esc(t('health.success', { p: pct(d.health.overall * 100) }))}</span></div>${health(d.health)}</section>
<section class="panel"><div class="panel-head"><h2>${esc(t('dist.title'))}</h2></div><div class="donuts">${donut(d.distribution.tokens, compact(tt.inputTokens + tt.outputTokens), t('dist.tokenUnit'), compact)}${donut(
      d.distribution.credits,
      cr(tt.credits),
      'Credits',
      cr,
    )}</div></section>`;
  }

  /** @param {string} key @param {string | undefined} value @param {string[][]} options */
  function select(key, value, options) {
    return `<select data-change="${key}">${options.map(([k, l]) => `<option value="${esc(k)}"${(value || '') === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }

  /** @param {any} r */
  function outcomeBadge(r) {
    const name = OUTCOMES.includes(r.outcome) ? t('outcome.' + r.outcome) : t('outcome.unknown');
    const tags = (r.isRetry ? `<span class="tag">${esc(t('requests.retry'))}</span>` : '') + (r.isFallback ? `<span class="tag">${esc(t('requests.fallback'))}</span>` : '');
    return `<span class="badge ${esc(r.outcome)}" title="${esc(r.errorType || '')}">${esc(name)}</span>${tags}`;
  }

  const legacyTag = () => `<span class="tag">${esc(t('common.legacy'))}</span>`;

  /** @param {string[]} keys */
  const thead = (keys) => `<thead><tr>${keys.map((k) => (k.startsWith('#') ? `<th class="num">${esc(t('col.' + k.slice(1)))}</th>` : `<th>${esc(t('col.' + k))}</th>`)).join('')}</tr></thead>`;

  /** @param {any} d */
  function renderRequests(d) {
    const f = state.filters;
    const filters = `<div class="filters">${select('model', f.model, [['', t('requests.allModels')], ...d.models.map((/** @type {string} */ m) => [m, m])])}${select('session', f.session, [
      ['', t('requests.allSessions')],
      ...d.sessions.map((/** @type {any} */ s) => [s.id, titleOf(s.id, s.title)]),
    ])}${select('outcome', f.outcome, [['', t('requests.allOutcomes')], ...OUTCOMES.map((k) => [k, t('outcome.' + k)])])}<span class="muted">${esc(
      t('requests.count', { n: int(d.total) }) + (d.truncated ? t('requests.truncated', { n: d.rows.length }) : ''),
    )}</span></div>`;
    if (!d.rows.length) return caption(d.range) + filters + empty(t('requests.empty'));
    const rows = d.rows
      .map((/** @type {any} */ r) => {
        const title = titleOf(r.sessionId, r.sessionTitle);
        return `<tr>
<td title="${esc(full(r.ts))}">${esc(mdhm(r.ts))}</td>
<td class="ellipsis"><a data-action="session" data-id="${esc(r.sessionId)}" title="${esc(title)}">${esc(title)}</a>${r.source === 'legacy' ? legacyTag() : ''}</td>
<td>${esc(r.modelId || '—')}</td>
<td>${outcomeBadge(r)}</td>
<td class="num">${pct(r.contextPct)}</td>
<td class="num">${compact(r.inputTokens)}</td>
<td class="num">${compact(r.outputTokens)}</td>
<td class="num">${cr(r.credits)}</td>
<td class="num">${dur(r.ttftMs)}</td>
<td class="num">${dur(r.durationMs)}</td>
<td class="num">${speed(r.speed)}</td>
</tr>`;
      })
      .join('');
    const head = thead(['time', 'session', 'model', 'status', '#context', '#input', '#output', '#credits', '#ttft', '#duration', '#speed']);
    return `${caption(d.range)}${filters}<div class="table-wrap"><table>${head}<tbody>${rows}</tbody></table></div>`;
  }

  /** @param {string} k @param {string} v @param {string} [sub] */
  const stat = (k, v, sub) => `<div class="stat"><div class="stat-k">${esc(k)}</div><div class="stat-v">${v}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;

  /** @param {any} s */
  function sessionCard(s) {
    const c = s.credits;
    const legacy = s.source === 'legacy';
    const title = titleOf(s.id, s.title);
    const stats = [
      stat(t('session.turns'), `${int(s.turns)} / ${int(s.requests)} / ${int(s.toolCalls)}`),
      stat(t('session.tokens'), compact(s.tokens.total), esc(t('session.tokenSub', { i: compact(s.tokens.input), o: compact(s.tokens.output) }))),
      stat(
        t('session.credits'),
        c ? `${cr(c.total)} <span class="muted">≈ ${usd(c.usd)}</span>` : '—',
        esc(c ? t('session.creditSplit', { m: cr(c.main), d: cr(c.delegated), a: cr(c.aux) }) : t('session.noCredits')),
      ),
      stat(t('session.context'), pct(s.context.pct), legacy ? '' : `≈ ${compact(s.context.tokens)} / ${compact(s.context.window, 0)}`),
      stat(t('session.ttft'), dur(s.timing.avgTtftMs)),
      stat(t('session.times'), `${dur(s.timing.modelTimeMs)}${s.timing.modelTimeEstimated && ok(s.timing.modelTimeMs) ? '≈' : ''} / ${dur(s.timing.toolTimeMs)}`),
      stat(t('session.speed'), speed(s.speed.avg), esc(t('session.speedSub', { p: speed(s.speed.peak), l: speed(s.speed.latest) }))),
      stat(t('session.outcomes'), `${int(s.outcomes.ok)} / ${int(s.outcomes.error)} / ${int(s.outcomes.cancelled)}`),
    ].join('');
    return `<section class="panel session-card"><div class="panel-head"><h2 class="ellipsis" title="${esc(title)}">${esc(title)}</h2>${
      legacy ? legacyTag() : ''
    }<div class="grow"></div><span class="muted">${esc(s.modelId || '')} · ${esc(mdhm(s.updatedAt))}</span><button class="icon-btn" data-action="close-session" title="${esc(t('common.close'))}" aria-label="${esc(t('common.close'))}">✕</button></div>${
      s.workspace ? `<div class="muted small ellipsis" title="${esc(s.workspace)}">${esc(s.workspace)}</div>` : ''
    }<div class="stats">${stats}</div>${legacy ? `<div class="card-note">${esc(t('session.legacyNote'))}</div>` : ''}</section>`;
  }

  /** @param {any} d */
  function renderSessions(d) {
    const top = d.selected ? sessionCard(d.selected) : '';
    if (!d.rows.length) return caption(d.range) + top + empty(t('session.empty'));
    const q = state.sessionQuery.trim().toLowerCase();
    const wsOnly = !!(state.sessionWorkspaceOnly && d.hasWorkspace);
    const filtered = d.rows.filter((/** @type {any} */ s) => {
      if (wsOnly && !s.inWorkspace) return false;
      if (!q) return true;
      const hay = `${titleOf(s.id, s.title)} ${s.workspace || ''} ${s.modelId || ''}`.toLowerCase();
      return hay.includes(q);
    });
    const wsToggle = d.hasWorkspace
      ? `<label class="check"><input type="checkbox" data-change="session-ws"${state.sessionWorkspaceOnly ? ' checked' : ''}>${esc(t('session.currentWorkspace'))}</label>`
      : '';
    const countText =
      q || wsOnly ? t('session.countFiltered', { n: int(filtered.length), total: int(d.rows.length) }) : t('session.count', { n: int(d.rows.length) });
    const filters = `<div class="filters"><input type="search" class="search" data-input="session-query" value="${esc(state.sessionQuery)}" placeholder="${esc(t('session.search'))}">${wsToggle}<span class="muted">${esc(countText)}</span></div>`;
    if (!filtered.length) return caption(d.range) + top + filters + empty(t('session.noMatch'));
    const rows = filtered
      .map((/** @type {any} */ s) => {
        const title = titleOf(s.id, s.title);
        return `<tr class="clickable${d.selected && d.selected.id === s.id ? ' selected' : ''}" data-action="session" data-id="${esc(s.id)}">
<td class="ellipsis" title="${esc(title)}">${esc(title)}${s.source === 'legacy' ? legacyTag() : ''}</td>
<td class="ellipsis muted" title="${esc(s.workspace || '')}">${esc(s.workspace ? s.workspace.split(/[\\/]/).pop() : '—')}</td>
<td>${esc(s.modelId || '—')}</td>
<td class="num">${int(s.turns)}</td>
<td class="num">${int(s.requests)}</td>
<td class="num">${cr(s.credits)}</td>
<td class="num">${compact(s.tokens)}</td>
<td class="num">${pct(s.contextPct)}</td>
<td title="${esc(full(s.updatedAt))}">${esc(mdhm(s.updatedAt))}</td>
</tr>`;
      })
      .join('');
    const head = thead(['session', 'workspace', 'model', '#turns', '#requests', '#credits', '#tokens', '#context', 'lastActive']);
    return `${caption(d.range)}${top}${filters}<div class="table-wrap"><table>${head}<tbody>${rows}</tbody></table></div>`;
  }

  /** @param {string} name @param {number | null} used @param {number | null} limit @param {string} [extra] HTML */
  function meter(name, used, limit, extra) {
    const p = ok(used) && limit ? Math.min(100, (/** @type {number} */ (used) / limit) * 100) : 0;
    const cls = p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'good';
    return `<div class="meter"><div class="meter-head"><span>${esc(name)}</span><span><b>${cr(used)}</b> / ${cr(limit)} <span class="muted">(${pct(p)})</span></span></div><div class="bar"><div class="bar-fill ${cls}" style="width:${p.toFixed(2)}%"></div></div>${
      extra ? `<div class="muted small">${extra}</div>` : ''
    }</div>`;
  }

  /** @param {any[]} daily @param {boolean} utc days are UTC calendar days */
  function bars(daily, utc) {
    const day = utc ? utcMd : md;
    const W = 600;
    const H = 90;
    const max = Math.max(0, ...daily.map((x) => x.credits));
    const bw = W / Math.max(1, daily.length);
    const rects = daily
      .map((x, i) => {
        const h = max > 0 ? (x.credits / max) * (H - 4) : 0;
        const tip = t('quota.barTip', { d: day(x.day), utc: utc ? t('quota.utc') : '', c: cr(x.credits), n: x.requests });
        return `<rect class="bar-rect" x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(tip)}</title></rect>`;
      })
      .join('');
    const first = daily.length ? day(daily[0].day) : '';
    const last = daily.length ? day(daily[daily.length - 1].day) : '';
    return `<svg class="bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${rects}</svg><div class="bars-axis"><span>${esc(first)}</span><span>${esc(last)}</span></div>`;
  }

  /** @param {any} d */
  function renderQuota(d) {
    const q = d.quota;
    if (!q) return empty(t('quota.empty'));
    const resetAt = q.resetAt ? Date.parse(q.resetAt) : NaN;
    const daysLeft = Number.isFinite(resetAt) ? Math.max(0, Math.ceil((resetAt - d.meta.now) / 86400000)) : null;
    const bonus = (q.bonuses || [])
      .map((/** @type {any} */ b) =>
        meter(b.name, b.used, b.limit, b.expiresAt ? esc(t('quota.expires', { d: ymd(b.expiresAt, d.meta.now) })) + (b.status && b.status !== 'ACTIVE' ? ` · ${esc(b.status)}` : '') : ''),
      )
      .join('');
    const overage = t(q.overageEnabled == null ? 'quota.unknown' : q.overageEnabled ? 'quota.on' : 'quota.off');
    const reset = Number.isFinite(resetAt)
      ? `<span title="${esc(t('utcNote'))}">${esc(t('quota.reset', { d: utcMd(resetAt), local: mdhm(resetAt), n: daysLeft }))}</span>`
      : '';
    const fc = d.cycle.forecast;
    let paceCard = '';
    if (fc) {
      const paceSub =
        fc.remainingCredits <= 0
          ? t('quota.limitReached')
          : fc.runsOutBeforeReset
            ? t('quota.runsOut', { d: Math.max(1, Math.round(fc.daysUntilLimit)), p: cr(fc.projected) })
            : t('quota.projected', { p: cr(fc.projected) });
      paceCard = stat(t('quota.pace'), esc(t('quota.perDay', { c: cr(fc.dailyAvg) })), esc(paceSub));
    }
    return `<section class="panel">
<div class="panel-head"><h2>${esc(q.plan || t('quota.plan'))}</h2><div class="grow"></div><span class="muted">${esc(t('quota.updated', { t: mdhm(q.updatedAt) }))}</span></div>
${meter(t('quota.cycle'), q.used, q.limit, reset)}
${bonus}
<div class="stats">
${stat(t('quota.overage'), esc(overage), ok(q.overageRate) ? esc(t('quota.overageRate', { r: q.overageRate })) : '')}
${stat(t('quota.local'), cr(d.cycle.localCredits), esc(t('quota.localNote')))}
${stat(t('quota.usd'), usd((q.used ?? 0) * d.meta.price), esc(t('quota.atPrice', { p: d.meta.price })))}
${paceCard}
</div>
</section>
<section class="panel"><div class="panel-head"><h2>${esc(t('quota.daily'))}</h2></div>${bars(d.cycle.daily, !!d.cycle.utc)}</section>`;
  }

  setLang(state.lang);
  render();
  vscode.postMessage({ type: 'ready' });
})();
