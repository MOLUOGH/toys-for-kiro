// @ts-check
'use strict';

const vscode = require('vscode');
const f = require('./format');
const i18n = require('../media/i18n');

/** Escape text for a MarkdownString (titles come from user prompts). @param {string} s */
function md(s) {
  return String(s ?? '').replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&').replace(/\r?\n/g, ' ');
}

const ENABLED_COMMANDS = ['toysForKiro.openDashboard', 'toysForKiro.exportData', 'toysForKiro.openSettings'];

class SessionStatusBar {
  constructor() {
    this.item = vscode.window.createStatusBarItem('toysForKiro.session', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Kiro Usage';
  }

  /**
   * @param {{ stats: ReturnType<typeof import('./core/analytics').buildSessionStats> | null, today?: { credits: number, requests: number }, cycleCredits?: number, quota: any, price: number, storage?: string } | null} data
   * @param {'zh' | 'en'} [lang]
   * @param {'session' | 'today' | 'cycle'} [mode]
   */
  update(data, lang = 'zh', mode = 'session') {
    const t = (/** @type {string} */ key, /** @type {Record<string, unknown>} */ params) => i18n.t(lang, key, params);
    const item = this.item;
    const actions = `[$(pie-chart) ${t('status.actDashboard')}](command:toysForKiro.openDashboard) · [$(export) ${t('status.actExport')}](command:toysForKiro.exportData) · [$(gear) ${t('status.actSettings')}](command:toysForKiro.openSettings)`;
    if (!data) {
      item.text = '$(pie-chart) Kiro Usage';
      const idleTip = new vscode.MarkdownString();
      idleTip.supportThemeIcons = true;
      idleTip.isTrusted = { enabledCommands: ENABLED_COMMANDS };
      idleTip.appendMarkdown(`**Kiro Usage**\n\n${md(t('status.none'))}\n\n---\n\n${actions}`);
      item.tooltip = idleTip;
      item.command = 'toysForKiro.openDashboard';
      item.backgroundColor = undefined;
      item.show();
      return;
    }
    const s = data.stats ?? null;
    const { quota, price } = data;
    const ctxPrefix = s && typeof s.context.pct === 'number' ? `${f.pct(s.context.pct)} · ` : '';
    if (mode === 'today') {
      const todayCr = f.credits(data.today?.credits ?? 0);
      item.text = `$(pie-chart) ${ctxPrefix}${t('status.todayShort', { c: todayCr })}`;
      item.command = { command: 'toysForKiro.openDashboard', title: t('status.open'), arguments: [{ view: 'overview', range: 'today' }] };
    } else if (mode === 'cycle') {
      const cyclePart =
        quota && quota.percent != null
          ? t('status.cycleShort', { p: f.pct(quota.percent) })
          : t('status.cycleLocalShort', { c: f.credits(data.cycleCredits ?? 0) });
      item.text = `$(pie-chart) ${ctxPrefix}${cyclePart}`;
      item.command = { command: 'toysForKiro.openDashboard', title: t('status.open'), arguments: [{ view: 'quota' }] };
    } else if (s) {
      const c = s.credits;
      item.text = `$(pie-chart) ${f.pct(s.context.pct)} · ${f.credits(c?.total)} cr`;
      item.command = { command: 'toysForKiro.openDashboard', title: t('status.open'), arguments: [{ view: 'sessions', sessionId: s.id }] };
    } else {
      item.text = '$(pie-chart) Kiro Usage';
      item.command = 'toysForKiro.openDashboard';
    }

    item.backgroundColor =
      s && typeof s.context.pct === 'number' && s.context.pct >= 90
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : s && typeof s.context.pct === 'number' && s.context.pct >= 75
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;

    const tip = new vscode.MarkdownString();
    tip.supportThemeIcons = true;
    tip.isTrusted = { enabledCommands: ENABLED_COMMANDS };
    if (s) {
      const c = s.credits;
      tip.appendMarkdown(`**${md(t('status.title'))}**\n\n${md(s.title || s.id)}\n\n`);
      const rows = [
        [t('status.turns'), `${s.turns} / ${s.requests} / ${s.toolCalls}`],
        [t('status.credits'), c ? t('status.creditsValue', { c: f.credits(c.total), usd: f.usd(c.usd) }) : '—'],
        [t('status.tokens'), t('status.tokensValue', { t: f.compact(s.tokens.total), i: f.compact(s.tokens.input), o: f.compact(s.tokens.output) })],
        [t('status.context'), `${f.pct(s.context.pct)} ≈ ${f.compact(s.context.tokens)} / ${f.compact(s.context.window, 0)}`],
        [t('status.ttft'), f.duration(s.timing.avgTtftMs)],
        [t('status.times'), `${f.duration(s.timing.modelTimeMs)}${s.timing.modelTimeEstimated ? '≈' : ''} / ${f.duration(s.timing.toolTimeMs)}`],
        [t('status.speed'), t('status.speedValue', { a: f.speed(s.speed.avg), l: f.speed(s.speed.latest) })],
      ];
      if (c && (c.delegated > 0 || c.aux > 0)) rows.splice(2, 0, [t('status.split'), `${f.credits(c.delegated)} / ${f.credits(c.aux)}`]);
      if (s.outcomes.error || s.outcomes.cancelled) rows.push([t('status.errors'), `${s.outcomes.error} / ${s.outcomes.cancelled}`]);
      tip.appendMarkdown(`| ${md(t('status.metric'))} | ${md(t('status.value'))} |\n|:--|--:|\n`);
      for (const [k, v] of rows) tip.appendMarkdown(`| ${md(k)} | ${md(v)} |\n`);
    } else {
      tip.appendMarkdown(`**Kiro Usage**\n\n${md(t('status.none'))}\n\n`);
    }
    const summaryLines = [];
    if (data.today && (s || mode === 'today' || data.today.requests > 0 || data.today.credits > 0)) {
      summaryLines.push(md(t('status.todayLine', { c: f.credits(data.today.credits), r: data.today.requests })));
    }
    if (quota && quota.used != null) {
      summaryLines.push(md(t('status.cycle', { u: f.credits(quota.used), l: f.credits(quota.limit), p: f.pct(quota.percent), d: f.billingDay(quota.resetAt) })));
    }
    if (summaryLines.length) {
      tip.appendMarkdown(`\n---\n\n${summaryLines.join('\n\n')}\n\n`);
    }
    const footer = t('status.footer', { p: price, storage: data.storage === 'memory' ? t('status.memory') : '' });
    tip.appendMarkdown(`\n---\n\n${actions}\n\n*${md(footer)}*`);
    item.tooltip = tip;
    item.show();
  }

  hide() {
    this.item.hide();
  }

  dispose() {
    this.item.dispose();
  }
}

module.exports = { SessionStatusBar };
