// @ts-check
'use strict';

/** 50940000 -> "50.94M" @param {number | null | undefined} n */
function compact(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(digits === 2 ? 1 : digits)}K`;
  return String(Math.round(n));
}

/** @param {number | null | undefined} n */
function credits(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n >= 100 ? n.toFixed(1) : n.toFixed(2);
}

/** @param {number | null | undefined} n */
function usd(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n >= 100 ? n.toFixed(0) : n.toFixed(2)}`;
}

/** @param {number | null | undefined} n */
function pct(n, digits = 1) {
  return n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`;
}

/** @param {number | null | undefined} ms */
function duration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** @param {number | null | undefined} n */
function speed(n) {
  return n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(n >= 100 ? 0 : 1)} tok/s`;
}

/** @param {string | number | null | undefined} t */
function monthDay(t) {
  if (t == null) return '—';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '—' : `${d.getMonth() + 1}/${d.getDate()}`;
}

module.exports = { compact, credits, usd, pct, duration, speed, monthDay };
