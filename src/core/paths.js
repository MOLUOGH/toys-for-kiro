// @ts-check
'use strict';

const os = require('os');
const path = require('path');

/**
 * Locations of Kiro's local data. `userDataDir` is Kiro's Electron user-data
 * folder (%APPDATA%\Kiro on Windows); `kiroHome` is ~/.kiro.
 * @param {{ userDataDir?: string, kiroHome?: string }} [overrides]
 */
function resolveKiroPaths(overrides = {}) {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const userDataDir = overrides.userDataDir || path.join(appData, 'Kiro');
  const kiroHome = overrides.kiroHome || path.join(home, '.kiro');
  return {
    userDataDir,
    kiroHome,
    sessionsDir: path.join(kiroHome, 'sessions'),
    logsDir: path.join(userDataDir, 'logs'),
    globalStateDb: path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb'),
    legacyDir: path.join(userDataDir, 'User', 'globalStorage', 'kiro.kiroagent'),
  };
}

/**
 * The extension's globalStorage is <userData>/User/globalStorage/<extension-id>,
 * so Kiro's user-data dir is three levels up. This keeps portable installs and
 * --user-data-dir working.
 * @param {string} globalStoragePath
 */
function userDataDirFromGlobalStorage(globalStoragePath) {
  return path.resolve(globalStoragePath, '..', '..', '..');
}

module.exports = { resolveKiroPaths, userDataDirFromGlobalStorage };
