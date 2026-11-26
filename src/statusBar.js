// @ts-check
'use strict';

const vscode = require('vscode');
const f = require('./format');
const i18n = require('../media/i18n');

/** Escape text for a MarkdownString (titles come from user prompts). @param {string} s */
function md(s) {
  return String(s ?? '').replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&').replace(/\r?\n/g, ' ');
}

class SessionStatusBar {
  constructor() {
    this.item = vscode.window.createStatusBarItem('toysForKiro.session', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Toys for Kiro';
  }

  /**
   * @param {{ stats: ReturnType<typeof import('./core/analytics').buildSessionStats>, quota: any, price: number, storage?: string } | null} data
   * @param {'zh' | 'en'} [lang]
   */
  update(data, lang = 'zh') {
    const t = (/** @type {string} */ key, /** @type {Record<string, unknown>} */ params) => i18n.t(lang, key, params);
    const item = this.item;
    if (!data) {
      item.text = '$(pie-chart) Toys for Kiro';
      item.tooltip = t('status.none');
      item.command = 'toysForKiro.openDashboard';
      item.show();
      return;
    }
    const { stats: s, quota, price } = data;
    const c = s.credits;
    item.text = `$(pie-chart) ${f.pct(s.context.pct)} · ${f.credits(c?.total)} cr`;
    item.command = { command: 'toysForKiro.openDashboard', title: t('status.open'), arguments: [{ view: 'sessions', sessionId: s.id }] };

    const tip = new vscode.MarkdownString();
    tip.supportThemeIcons = true;
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
    if (quota && quota.used != null) {
      const line = t('status.cycle', { u: f.credits(quota.used), l: f.credits(quota.limit), p: f.pct(quota.percent), d: f.billingDay(quota.resetAt) });
      tip.appendMarkdown(`\n---\n\n${md(line)}\n\n`);
    }
    const footer = t('status.footer', { p: price, storage: data.storage === 'memory' ? t('status.memory') : '' });
    tip.appendMarkdown(`\n*${md(footer)}*`);
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
