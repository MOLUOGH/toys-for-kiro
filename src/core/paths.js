// @ts-check
'use strict';

const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

/**
 * Default Electron user-data directory for Kiro on each OS:
 * - Windows: %APPDATA%\Kiro  (fallback ~\AppData\Roaming\Kiro)
 * - macOS:   ~/Library/Application Support/Kiro
 * - Linux:   $XDG_CONFIG_HOME/Kiro  (fallback ~/.config/Kiro)
 * @param {{ platform?: string, homedir?: string, env?: NodeJS.ProcessEnv }} [ctx]
 */
function defaultUserDataDir(ctx = {}) {
  const platform = ctx.platform || process.platform;
  const home = ctx.homedir || os.homedir();
  const env = ctx.env || process.env;
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const appData = env.APPDATA || p.join(home, 'AppData', 'Roaming');
    return p.join(appData, 'Kiro');
  }
  if (platform === 'darwin') {
    return p.join(home, 'Library', 'Application Support', 'Kiro');
  }
  const xdg = env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(home, '.config');
  return p.join(xdg, 'Kiro');
}

/**
 * Locations of Kiro's local data. `userDataDir` is Kiro's Electron user-data
 * folder; `kiroHome` is ~/.kiro.
 * @param {{ userDataDir?: string, kiroHome?: string, platform?: string, homedir?: string, env?: NodeJS.ProcessEnv }} [overrides]
 */
function resolveKiroPaths(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const home = overrides.homedir || os.homedir();
  const userDataDir = overrides.userDataDir || defaultUserDataDir({ platform, homedir: home, env: overrides.env });
  const kiroHome = overrides.kiroHome || p.join(home, '.kiro');
  return {
    userDataDir,
    kiroHome,
    sessionsDir: p.join(kiroHome, 'sessions'),
    logsDir: p.join(userDataDir, 'logs'),
    globalStateDb: p.join(userDataDir, 'User', 'globalStorage', 'state.vscdb'),
    legacyDir: p.join(userDataDir, 'User', 'globalStorage', 'kiro.kiroagent'),
  };
}

/**
 * Normalize a workspace folder path or `file://` URI for comparison.
 * Windows and macOS (default APFS) compare case-insensitively; Linux preserves case.
 * @param {string} raw
 * @param {string} [platform]
 */
function normalizeWorkspacePath(raw, platform = process.platform) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (/^file:\/\//i.test(s)) {
    try {
      s = fileURLToPath(s, { windows: platform === 'win32' });
    } catch {
      const stripped = s.replace(/^file:\/\/\/?/i, platform === 'win32' ? '' : '/');
      try {
        s = decodeURIComponent(stripped);
      } catch {
        s = stripped;
      }
      if (platform === 'win32') s = s.replace(/^\/+([a-zA-Z]:)/, '$1');
    }
  }
  if (platform === 'win32') {
    s = s.replace(/^\/+([a-zA-Z]:)/, '$1').replace(/\//g, '\\').replace(/\\+$/, '');
    if (/^[a-zA-Z]:$/.test(s)) s += '\\';
    return (s || '\\').toLowerCase();
  }
  s = s.replace(/\/+$/, '') || '/';
  return platform === 'darwin' ? s.toLowerCase() : s;
}

/**
 * The extension's globalStorage is <userData>/User/globalStorage/<extension-id>,
 * so Kiro's user-data dir is three levels up. This keeps portable installs and
 * --user-data-dir working across Windows, macOS and Linux.
 * @param {string} globalStoragePath
 * @param {string} [platform]
 */
function userDataDirFromGlobalStorage(globalStoragePath, platform) {
  const isWin = platform ? platform === 'win32' : process.platform === 'win32' && !String(globalStoragePath).startsWith('/');
  return (isWin ? path.win32 : path.posix).resolve(globalStoragePath, '..', '..', '..');
}

module.exports = { resolveKiroPaths, defaultUserDataDir, normalizeWorkspacePath, userDataDirFromGlobalStorage };
