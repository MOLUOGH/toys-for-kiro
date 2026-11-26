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
    vscode.setState({ view: state.view, range: state.range, metric: state.metric, filters: state.filters, sessionId: state.sessionId, lang: state.lang });
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
        if (!state.range) state.range = m.defaultRange || 'cycle';
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
    const el = /** @type {HTMLSelectElement} */ (e.target);
    const key = el && el.dataset ? el.dataset.change : null;
    if (!key) return;
    if (key === 'range') state.range = el.value;
    else state.filters = Object.assign({}, state.filters, { [key]: el.value || undefined });
    load();
  });

  // ---------- rendering ----------
  function render() {
    const d = state.data;
    let body;
    if (state.error) body = `<div class="empty error">${esc(state.error)}</div>`;
    else if (!d || state.dataView !== state.view) body = `<div class="empty">${esc(t('common.loading'))}</div>`;
    else if (state.view === 'requests') body = renderRequests(d);
    else if (state.view === 'sessions') body = renderSessions(d);
    else if (state.view === 'quota') body = renderQuota(d);
    else body = renderOverview(d);
    root.innerHTML = header() + `<main>${body}</main>`;
  }

  function header() {
    const tabs = VIEWS.map((k) => `<button class="tab${state.view === k ? ' active' : ''}" data-action="view" data-view="${k}">${esc(t('view.' + k))}</button>`).join('');
    const range =
      state.view === 'quota'
        ? ''
        : `<select class="range" data-change="range" title="${esc(t('range.title'))}">${RANGES.map((k) => `<option value="${k}"${state.range === k ? ' selected' : ''}>${esc(t('range.' + k))}</option>`).join('')}</select>`;
    return `<header class="top"><div class="brand">Toys for Kiro</div><nav class="tabs">${tabs}</nav><div class="grow"></div>${range}<button class="icon-btn" data-action="refresh" title="${esc(t('common.refresh'))}">⟳</button></header>`;
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
    }<div class="grow"></div><span class="muted">${esc(s.modelId || '')} · ${esc(mdhm(s.updatedAt))}</span><button class="icon-btn" data-action="close-session" title="${esc(t('common.close'))}">✕</button></div>${
      s.workspace ? `<div class="muted small ellipsis" title="${esc(s.workspace)}">${esc(s.workspace)}</div>` : ''
    }<div class="stats">${stats}</div>${legacy ? `<div class="card-note">${esc(t('session.legacyNote'))}</div>` : ''}</section>`;
  }

  /** @param {any} d */
  function renderSessions(d) {
    const top = d.selected ? sessionCard(d.selected) : '';
    if (!d.rows.length) return caption(d.range) + top + empty(t('session.empty'));
    const rows = d.rows
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
    return `${caption(d.range)}${top}<div class="table-wrap"><table>${head}<tbody>${rows}</tbody></table></div>`;
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
    return `<section class="panel">
<div class="panel-head"><h2>${esc(q.plan || t('quota.plan'))}</h2><div class="grow"></div><span class="muted">${esc(t('quota.updated', { t: mdhm(q.updatedAt) }))}</span></div>
${meter(t('quota.cycle'), q.used, q.limit, reset)}
${bonus}
<div class="stats">
${stat(t('quota.overage'), esc(overage), ok(q.overageRate) ? esc(t('quota.overageRate', { r: q.overageRate })) : '')}
${stat(t('quota.local'), cr(d.cycle.localCredits), esc(t('quota.localNote')))}
${stat(t('quota.usd'), usd((q.used ?? 0) * d.meta.price), esc(t('quota.atPrice', { p: d.meta.price })))}
</div>
</section>
<section class="panel"><div class="panel-head"><h2>${esc(t('quota.daily'))}</h2></div>${bars(d.cycle.daily, !!d.cycle.utc)}</section>`;
  }

  setLang(state.lang);
  render();
  vscode.postMessage({ type: 'ready' });
})();
