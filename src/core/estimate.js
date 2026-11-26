// @ts-check
'use strict';

/** Context window assumed when the model's window is unknown (Kiro behaves the same way). */
const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Rough token count for visible text, using the same rule Kiro applies to Claude
 * models (characters / 4) but counting CJK characters as one token each.
 * @param {string | null | undefined} text
 */
function estimateTokens(text) {
  if (!text) return 0;
  const n = text.length;
  let cjk = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 0x2e80 && c <= 0x9fff) ||
      (c >= 0xac00 && c <= 0xd7af) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xffef)
    ) {
      cjk++;
    }
  }
  return Math.ceil(cjk + (n - cjk) / 4);
}

/**
 * @typedef {{ contextWindowTokens?: number, modelContextWindows?: Record<string, number> }} WindowSettings
 */

/**
 * @param {string | null | undefined} modelId
 * @param {WindowSettings} settings
 */
function contextWindowFor(modelId, settings) {
  const map = settings.modelContextWindows || {};
  if (modelId && typeof map[modelId] === 'number' && map[modelId] > 0) return map[modelId];
  const w = settings.contextWindowTokens;
  return typeof w === 'number' && w > 0 ? w : DEFAULT_CONTEXT_WINDOW;
}

/**
 * Convert the server-reported context usage percentage into tokens.
 * @param {number | null | undefined} pct
 * @param {string | null | undefined} modelId
 * @param {WindowSettings} settings
 */
function inputTokensFromPct(pct, modelId, settings) {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  return Math.round((pct / 100) * contextWindowFor(modelId, settings));
}

module.exports = { DEFAULT_CONTEXT_WINDOW, estimateTokens, contextWindowFor, inputTokensFromPct };
