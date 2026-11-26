// @ts-check
/* global acquireVsCodeApi */
(function () {
  'use strict';

  // @ts-ignore provided by the webview host
  const vscode = acquireVsCodeApi();
  const root = /** @type {HTMLElement} */ (document.getElementById('root'));
  const saved = vscode.getState() || {};
  const state = {
    view: saved.view || 'overview',
    range: saved.range || null,
    metric: saved.metric || 'tokens',
    filters: saved.filters || {},
    sessionId: saved.sessionId || null,
    /** @type {any} */ data: null,
    dataView: null,
    lastJson: '',
    error: '',
    seq: 0,
  };

  const VIEWS = [
    ['overview', '概览'],
    ['requests', '请求'],
    ['sessions', '会话'],
    ['quota', '额度'],
  ];
  const RANGES = [
    ['cycle', '本计费周期'],
    ['today', '今天'],
    ['24h', '最近 24 小时'],
    ['7d', '最近 7 天'],
    ['30d', '最近 30 天'],
    ['all', '全部时间'],
  ];
  const OUTCOMES = { ok: '成功', error: '错误', cancelled: '取消', unknown: '未知' };

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
  const int = (n) => (ok(n) ? Math.round(/** @type {number} */ (n)).toLocaleString() : '—');
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
  /** @param {number | string | null | undefined} t */
  function md(t) {
    if (t == null) return '—';
    const d = new Date(t);
    return d.getMonth() + 1 + '/' + d.getDate();
  }
  /** @param {number | string | null | undefined} t */
  function mdhm(t) {
    if (t == null) return '—';
    const d = new Date(t);
    return md(t) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  /** @param {number | string | null | undefined} t */
  function full(t) {
    if (t == null) return '';
    const d = new Date(t);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // ---------- state & messaging ----------
  function persist() {
    vscode.setState({ view: state.view, range: state.range, metric: state.metric, filters: state.filters, sessionId: state.sessionId });
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
        if (!state.range) state.range = m.defaultRange || 'cycle';
        if (m.view) state.view = m.view;
        if (m.sessionId) state.sessionId = m.sessionId;
        load();
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
        state.error = m.message || '未知错误';
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
    else if (!d || state.dataView !== state.view) body = '<div class="empty">加载中…</div>';
    else if (state.view === 'requests') body = renderRequests(d);
    else if (state.view === 'sessions') body = renderSessions(d);
    else if (state.view === 'quota') body = renderQuota(d);
    else body = renderOverview(d);
    root.innerHTML = header() + `<main>${body}</main>`;
  }

  function header() {
    const tabs = VIEWS.map(([k, l]) => `<button class="tab${state.view === k ? ' active' : ''}" data-action="view" data-view="${k}">${l}</button>`).join('');
    const range =
      state.view === 'quota'
        ? ''
        : `<select class="range" data-change="range" title="时间范围">${RANGES.map(([k, l]) => `<option value="${k}"${state.range === k ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    return `<header class="top"><div class="brand">Toys for Kiro</div><nav class="tabs">${tabs}</nav><div class="grow"></div>${range}<button class="icon-btn" data-action="refresh" title="重新扫描本地数据">⟳</button></header>`;
  }

  /** Billing dates are UTC calendar dates, as Kiro shows them. @param {number | string | null | undefined} t */
  function utcMd(t) {
    if (t == null) return '—';
    const d = new Date(t);
    return d.getUTCMonth() + 1 + '/' + d.getUTCDate();
  }
  const UTC_NOTE = 'Kiro 按 UTC 时间每月 1 号 0 点重置额度，周期日期按 UTC 显示。';

  /** "11/25", or "2027/11/25" when not in the current year. @param {number | string} t @param {number} now */
  function ymd(t, now) {
    const d = new Date(t);
    return d.getFullYear() === new Date(now).getFullYear() ? md(t) : `${d.getFullYear()}/${md(t)}`;
  }

  /** @param {any} r */
  function caption(r) {
    const memory =
      state.data && state.data.meta && state.data.meta.storage === 'memory'
        ? ' · <span title="不写入磁盘。延迟和错误记录只包含 Kiro 现存的日志。">内存模式</span>'
        : '';
    if (r.utc) {
      const reset = r.resetAt ? `（${utcMd(r.resetAt)} 重置）` : '';
      return `<div class="caption" title="${esc(UTC_NOTE)}">${esc(r.label)} · ${esc(utcMd(r.from))} – 现在${esc(reset)}${memory}</div>`;
    }
    return `<div class="caption">${esc(r.label)} · ${esc(mdhm(r.from))} – 现在${memory}</div>`;
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

  /** @param {number} t */
  const hm = (t) => {
    const d = new Date(t);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  };

  /** "5 分钟" / "2 小时" / "1 天" @param {number} unit */
  function unitLabel(unit) {
    if (unit >= DAY_MS) return Math.round(unit / DAY_MS) + ' 天';
    if (unit >= 3600000) return unit / 3600000 + ' 小时';
    return unit / 60000 + ' 分钟';
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
      const tip = `${when}\n请求 ${int(c.requests)} · Token ${compact(c.tokens)} · Credits ${cr(c.credits)}`;
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
      .map((/** @type {number} */ t, /** @type {number} */ i) => {
        let text = '';
        if (byTime) {
          if (i - lastCol >= gap) text = hm(t);
        } else {
          const day = md(t);
          if (day !== lastDay && i - lastCol >= gap) text = day;
          if (text) lastDay = day;
        }
        if (text) lastCol = i;
        return `<div class="hm-axis">${esc(text)}</div>`;
      })
      .join('');
    const legend = [0, 1, 2, 3, 4].map((l) => `<span class="hm-cell l${l}"></span>`).join('');
    return `<div class="heatmap" style="--cols:${h.cols}"><div class="hm-grid">${grid}</div><div class="hm-axis-row">${axis}</div></div>
<div class="hm-foot"><span>每格 ${esc(unitLabel(h.unit))}${daily ? '，每列一周（周一在上）' : '，从上到下、从左到右按时间排列'}</span><span class="hm-legend">少${legend}多</span></div>`;
  }

  /** @param {any} h */
  function health(h) {
    if (!h.models.length) return empty('这个时间范围内没有请求');
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
            const t0 = h.from + i * h.bucketMs;
            const tip = b.total ? `${mdhm(t0)} 起\n成功 ${b.ok} · 错误 ${b.error} · 取消 ${b.cancelled}` : `${mdhm(t0)} 起\n无请求`;
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
          .map(
            (x, i) =>
              `<li><span class="sw s${i % 7}"></span><span class="lg-name" title="${esc(x.label)}">${esc(x.label)}</span><span class="lg-val">${esc(fmt(x.value))}</span><span class="lg-pct">${total > 0 ? pct((x.value / total) * 100) : '—'}</span></li>`,
          )
          .join('')
      : '<li class="muted">无数据</li>';
    return `<div class="donut"><svg viewBox="0 0 120 120"><circle class="donut-track" r="${R}" cx="60" cy="60"/>${segs}<text x="60" y="60" class="donut-value">${esc(center)}</text><text x="60" y="76" class="donut-unit">${esc(unit)}</text></svg><ul class="legend">${legend}</ul></div>`;
  }

  /** @param {any} d */
  function renderOverview(d) {
    const t = d.totals;
    const status = `<span class="dot good"></span>${int(t.ok)} 成功 <span class="dot bad"></span>${int(t.errors)} 错误${t.cancelled ? ` <span class="dot neutral"></span>${int(t.cancelled)} 取消` : ''}`;
    const tokenSub = `${compact(t.inputTokens)} 输入 / ${compact(t.outputTokens)} 可见输出`;
    const tokenNote = `估算：输入 = 上下文占用 × ${compact(d.meta.window, 0)} 窗口；输出不含完整思考${t.legacyRequests ? `；含 ${t.legacyRequests} 条旧版记录` : ''}`;
    const creditSub = `≈ ${usd(t.usd)} · 平均 ${cr(t.avgCredits)} / 请求`;
    return `${caption(d.range)}
<section class="cards">
${card('请求数', int(t.requests), status, t.avgTtftMs != null ? `平均首包延迟 ${dur(t.avgTtftMs)}` : '', spark(d.spark.requests))}
${card('估算 Token', compact(t.inputTokens + t.outputTokens), tokenSub, tokenNote, spark(d.spark.tokens))}
${card('Credits', cr(t.credits), creditSub, `按 $${d.meta.price}/credit 折算`, spark(d.spark.credits))}
</section>
<section class="panel"><div class="panel-head"><h2>用量热力图</h2>${segmented('metric', state.metric, [
      ['tokens', 'Token'],
      ['requests', '请求'],
      ['credits', 'Credits'],
    ])}</div>${heatmap(d.heatmap, state.metric)}</section>
<section class="panel"><div class="panel-head"><h2>模型健康</h2><span class="muted">${d.health.overall == null ? '' : pct(d.health.overall * 100) + ' 成功'}</span></div>${health(d.health)}</section>
<section class="panel"><div class="panel-head"><h2>用量分布</h2></div><div class="donuts">${donut(d.distribution.tokens, compact(t.inputTokens + t.outputTokens), 'Token', compact)}${donut(
      d.distribution.credits,
      cr(t.credits),
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
    const label = /** @type {Record<string, string>} */ (OUTCOMES)[r.outcome] || '未知';
    const tags = (r.isRetry ? '<span class="tag">重试</span>' : '') + (r.isFallback ? '<span class="tag">回退</span>' : '');
    return `<span class="badge ${esc(r.outcome)}" title="${esc(r.errorType || '')}">${label}</span>${tags}`;
  }

  /** @param {any} d */
  function renderRequests(d) {
    const f = state.filters;
    const filters = `<div class="filters">${select('model', f.model, [['', '全部模型'], ...d.models.map((/** @type {string} */ m) => [m, m])])}${select('session', f.session, [
      ['', '全部会话'],
      ...d.sessions.map((/** @type {any} */ s) => [s.id, s.title || s.id]),
    ])}${select('outcome', f.outcome, [
      ['', '全部状态'],
      ['ok', '成功'],
      ['error', '错误'],
      ['cancelled', '取消'],
      ['unknown', '未知'],
    ])}<span class="muted">${int(d.total)} 条${d.truncated ? `，显示最近 ${d.rows.length} 条` : ''}</span></div>`;
    if (!d.rows.length) return caption(d.range) + filters + empty('没有符合条件的请求');
    const rows = d.rows
      .map(
        (/** @type {any} */ r) => `<tr>
<td title="${esc(full(r.ts))}">${esc(mdhm(r.ts))}</td>
<td class="ellipsis"><a data-action="session" data-id="${esc(r.sessionId)}" title="${esc(r.sessionTitle || r.sessionId)}">${esc(r.sessionTitle || r.sessionId)}</a>${r.source === 'legacy' ? '<span class="tag">旧版</span>' : ''}</td>
<td>${esc(r.modelId || '—')}</td>
<td>${outcomeBadge(r)}</td>
<td class="num">${pct(r.contextPct)}</td>
<td class="num">${compact(r.inputTokens)}</td>
<td class="num">${compact(r.outputTokens)}</td>
<td class="num">${cr(r.credits)}</td>
<td class="num">${dur(r.ttftMs)}</td>
<td class="num">${dur(r.durationMs)}</td>
<td class="num">${speed(r.speed)}</td>
</tr>`,
      )
      .join('');
    return `${caption(d.range)}${filters}<div class="table-wrap"><table><thead><tr><th>时间</th><th>会话</th><th>模型</th><th>状态</th><th class="num">上下文</th><th class="num">输入≈</th><th class="num">输出≈</th><th class="num">Credits</th><th class="num">首包</th><th class="num">耗时</th><th class="num">速度≈</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  /** @param {string} k @param {string} v @param {string} [sub] */
  const stat = (k, v, sub) => `<div class="stat"><div class="stat-k">${esc(k)}</div><div class="stat-v">${v}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;

  /** @param {any} s */
  function sessionCard(s) {
    const c = s.credits;
    const legacy = s.source === 'legacy';
    const stats = [
      stat('轮次 / 请求 / 工具调用', `${int(s.turns)} / ${int(s.requests)} / ${int(s.toolCalls)}`),
      stat('估算 Token', compact(s.tokens.total), `输入 ${compact(s.tokens.input)} · 可见输出 ${compact(s.tokens.output)}`),
      stat('Credits', c ? `${cr(c.total)} <span class="muted">≈ ${usd(c.usd)}</span>` : '—', c ? `主 ${cr(c.main)} · 子智能体 ${cr(c.delegated)} · 辅助 ${cr(c.aux)}` : '旧版会话没有 credits'),
      stat('上下文', pct(s.context.pct), legacy ? '' : `≈ ${compact(s.context.tokens)} / ${compact(s.context.window, 0)}`),
      stat('首包延迟（平均）', dur(s.timing.avgTtftMs)),
      stat('模型耗时 / 工具耗时', `${dur(s.timing.modelTimeMs)}${s.timing.modelTimeEstimated && ok(s.timing.modelTimeMs) ? '≈' : ''} / ${dur(s.timing.toolTimeMs)}`),
      stat('可见输出速度', speed(s.speed.avg), `峰值 ${speed(s.speed.peak)} · 最近 ${speed(s.speed.latest)}`),
      stat('成功 / 错误 / 取消', `${int(s.outcomes.ok)} / ${int(s.outcomes.error)} / ${int(s.outcomes.cancelled)}`),
    ].join('');
    return `<section class="panel session-card"><div class="panel-head"><h2 class="ellipsis" title="${esc(s.title)}">${esc(s.title || s.id)}</h2>${
      legacy ? '<span class="tag">旧版</span>' : ''
    }<div class="grow"></div><span class="muted">${esc(s.modelId || '')} · ${esc(mdhm(s.updatedAt))}</span><button class="icon-btn" data-action="close-session" title="关闭">✕</button></div>${
      s.workspace ? `<div class="muted small ellipsis" title="${esc(s.workspace)}">${esc(s.workspace)}</div>` : ''
    }<div class="stats">${stats}</div>${legacy ? '<div class="card-note">旧版会话：每次执行只按最终上下文估算一次输入，数值偏低。</div>' : ''}</section>`;
  }

  /** @param {any} d */
  function renderSessions(d) {
    const top = d.selected ? sessionCard(d.selected) : '';
    if (!d.rows.length) return caption(d.range) + top + empty('这个时间范围内没有活跃的会话');
    const rows = d.rows
      .map(
        (/** @type {any} */ s) => `<tr class="clickable${d.selected && d.selected.id === s.id ? ' selected' : ''}" data-action="session" data-id="${esc(s.id)}">
<td class="ellipsis" title="${esc(s.title)}">${esc(s.title || s.id)}${s.source === 'legacy' ? '<span class="tag">旧版</span>' : ''}</td>
<td class="ellipsis muted" title="${esc(s.workspace || '')}">${esc(s.workspace ? s.workspace.split(/[\\/]/).pop() : '—')}</td>
<td>${esc(s.modelId || '—')}</td>
<td class="num">${int(s.turns)}</td>
<td class="num">${int(s.requests)}</td>
<td class="num">${cr(s.credits)}</td>
<td class="num">${compact(s.tokens)}</td>
<td class="num">${pct(s.contextPct)}</td>
<td title="${esc(full(s.updatedAt))}">${esc(mdhm(s.updatedAt))}</td>
</tr>`,
      )
      .join('');
    return `${caption(d.range)}${top}<div class="table-wrap"><table><thead><tr><th>会话</th><th>工作区</th><th>模型</th><th class="num">轮次</th><th class="num">请求</th><th class="num">Credits</th><th class="num">Token≈</th><th class="num">上下文</th><th>最后活动</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  /** @param {string} label @param {number | null} used @param {number | null} limit @param {string} [extra] */
  function meter(label, used, limit, extra) {
    const p = ok(used) && limit ? Math.min(100, (/** @type {number} */ (used) / limit) * 100) : 0;
    const cls = p >= 90 ? 'bad' : p >= 70 ? 'warn' : 'good';
    return `<div class="meter"><div class="meter-head"><span>${esc(label)}</span><span><b>${cr(used)}</b> / ${cr(limit)} <span class="muted">(${pct(p)})</span></span></div><div class="bar"><div class="bar-fill ${cls}" style="width:${p.toFixed(2)}%"></div></div>${
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
        return `<rect class="bar-rect" x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(day(x.day))}${utc ? '（UTC）' : ''}：${esc(cr(x.credits))} credits · ${x.requests} 请求</title></rect>`;
      })
      .join('');
    const first = daily.length ? day(daily[0].day) : '';
    const last = daily.length ? day(daily[daily.length - 1].day) : '';
    return `<svg class="bars" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${rects}</svg><div class="bars-axis"><span>${esc(first)}</span><span>${esc(last)}</span></div>`;
  }

  /** @param {any} d */
  function renderQuota(d) {
    const q = d.quota;
    if (!q) return empty('还没读到额度信息。Kiro 每 5 分钟刷新一次额度，稍后再试。');
    const resetAt = q.resetAt ? Date.parse(q.resetAt) : NaN;
    const daysLeft = Number.isFinite(resetAt) ? Math.max(0, Math.ceil((resetAt - d.meta.now) / 86400000)) : null;
    const bonus = (q.bonuses || [])
      .map((/** @type {any} */ b) => meter(b.name, b.used, b.limit, b.expiresAt ? `${esc(ymd(b.expiresAt, d.meta.now))} 到期${b.status && b.status !== 'ACTIVE' ? ` · ${esc(b.status)}` : ''}` : ''))
      .join('');
    const overage = q.overageEnabled == null ? '未知' : q.overageEnabled ? '已开启' : '未开启';
    return `<section class="panel">
<div class="panel-head"><h2>${esc(q.plan || 'Kiro 套餐')}</h2><div class="grow"></div><span class="muted">更新于 ${esc(mdhm(q.updatedAt))}</span></div>
${meter('本计费周期', q.used, q.limit, Number.isFinite(resetAt) ? `<span title="${esc(UTC_NOTE)}">${esc(utcMd(resetAt))} 重置（UTC 0 点，你的时间 ${esc(mdhm(resetAt))}），还剩 ${daysLeft} 天</span>` : '')}
${bonus}
<div class="stats">
${stat('超额', overage, ok(q.overageRate) ? `超额单价 $${q.overageRate}/credit` : '')}
${stat('本地统计（本周期）', cr(d.cycle.localCredits), '本机会话记录的 credits，不含其他设备')}
${stat('折算美元', usd((q.used ?? 0) * d.meta.price), `按 $${d.meta.price}/credit`)}
</div>
</section>
<section class="panel"><div class="panel-head"><h2>本周期每日 credits（本机，按 UTC 日期）</h2></div>${bars(d.cycle.daily, !!d.cycle.utc)}</section>`;
  }

  render();
  vscode.postMessage({ type: 'ready' });
})();
