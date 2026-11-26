// @ts-check
'use strict';

const vscode = require('vscode');
const f = require('./format');

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
   */
  update(data) {
    const item = this.item;
    if (!data) {
      item.text = '$(pie-chart) Toys for Kiro';
      item.tooltip = '还没有找到 Kiro 会话。点击打开用量面板。';
      item.command = 'toysForKiro.openDashboard';
      item.show();
      return;
    }
    const { stats: s, quota, price } = data;
    const c = s.credits;
    item.text = `$(pie-chart) ${f.pct(s.context.pct)} · ${f.credits(c?.total)} cr`;
    item.command = { command: 'toysForKiro.openDashboard', title: '打开会话统计', arguments: [{ view: 'sessions', sessionId: s.id }] };

    const t = new vscode.MarkdownString();
    t.supportThemeIcons = true;
    t.appendMarkdown(`**Toys for Kiro · 当前会话**\n\n${md(s.title || s.id)}\n\n`);
    const rows = [
      ['轮次 / 请求 / 工具调用', `${s.turns} / ${s.requests} / ${s.toolCalls}`],
      ['Credits', c ? `${f.credits(c.total)}（≈ ${f.usd(c.usd)}）` : '—'],
      ['估算 Token', `${f.compact(s.tokens.total)}（输入 ${f.compact(s.tokens.input)} / 可见输出 ${f.compact(s.tokens.output)}）`],
      ['上下文', `${f.pct(s.context.pct)} ≈ ${f.compact(s.context.tokens)} / ${f.compact(s.context.window, 0)}`],
      ['首包延迟（平均）', f.duration(s.timing.avgTtftMs)],
      ['模型耗时 / 工具耗时', `${f.duration(s.timing.modelTimeMs)}${s.timing.modelTimeEstimated ? '≈' : ''} / ${f.duration(s.timing.toolTimeMs)}`],
      ['可见输出速度', `平均 ${f.speed(s.speed.avg)} · 最近 ${f.speed(s.speed.latest)}`],
    ];
    if (c && (c.delegated > 0 || c.aux > 0)) rows.splice(2, 0, ['其中 子智能体 / 辅助', `${f.credits(c.delegated)} / ${f.credits(c.aux)}`]);
    if (s.outcomes.error || s.outcomes.cancelled) rows.push(['错误 / 取消', `${s.outcomes.error} / ${s.outcomes.cancelled}`]);
    t.appendMarkdown('| 指标 | 值 |\n|:--|--:|\n');
    for (const [k, v] of rows) t.appendMarkdown(`| ${md(k)} | ${md(v)} |\n`);
    if (quota && quota.used != null) {
      t.appendMarkdown(
        `\n---\n\n本计费周期：${md(f.credits(quota.used))} / ${md(f.credits(quota.limit))} credits（${md(f.pct(quota.percent))}）· ${md(f.billingDay(quota.resetAt))} 重置\n\n`,
      );
    }
    const storage = data.storage === 'memory' ? '内存模式，不写入磁盘。' : '';
    t.appendMarkdown(`\n*Token 为估算值；美元按 $${md(String(price))}/credit 折算。${storage}点击查看详情。*`);
    item.tooltip = t;
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
