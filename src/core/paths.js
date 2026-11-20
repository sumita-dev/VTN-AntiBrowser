/**
 * VTN Anti-Browser Unified Path Resolver (`src/core/paths.js`)
 * Resolves runtime directories (`BIN_DIR`, `DATA_DIR`, `UI_DIR`) and UI assets
 * seamlessly in both Development mode (`!sea.isSea()`) and Single Executable
 * Application mode (`sea.isSea()`).
 */

const fs = require('node:fs');
const path = require('node:path');

let sea = { isSea: () => false, getRawAsset: () => null };
try {
  sea = require('node:sea');
} catch {
  // Fallback for environments without node:sea
}

const IS_SEA = typeof sea.isSea === 'function' && sea.isSea();

const APP_ROOT = IS_SEA
  ? (process.env.VTN_HOME ? path.resolve(process.env.VTN_HOME) : path.dirname(process.execPath))
  : path.resolve(__dirname, '..', '..');

const BIN_DIR = path.join(APP_ROOT, 'bin');
const DATA_DIR = path.join(APP_ROOT, 'data');
const UI_DIR = IS_SEA
  ? path.join(APP_ROOT, 'ui')
  : path.join(APP_ROOT, 'src', 'ui');

/**
 * Ensures runtime directories (`DATA_DIR` and `BIN_DIR`) exist on disk.
 */
function ensureRuntimeDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

/**
 * Reads a UI asset either from disk (dev mode or customUiDir override)
 * or from the embedded SEA asset blob (`ui/<relPath>`).
 * Prevents path traversal in both modes.
 *
 * @param {string} relPath
 * @param {string} [customUiDir]
 * @returns {Buffer|null}
 */
function readUiAsset(relPath, customUiDir) {
  const cleanRel = String(relPath || '').replace(/^[/\\]+/, '');
  if (!cleanRel) return null;

  if (customUiDir || !IS_SEA) {
    const baseDir = path.resolve(customUiDir || UI_DIR);
    const filePath = path.resolve(baseDir, cleanRel);
    if (filePath !== baseDir && !filePath.startsWith(baseDir + path.sep)) {
      return null;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return fs.readFileSync(filePath);
    }
    return null;
  }

  const posixRel = path.posix.normalize(cleanRel.replace(/\\/g, '/'));
  if (!posixRel || posixRel === '.' || posixRel.startsWith('..') || path.posix.isAbsolute(posixRel)) {
    return null;
  }

  try {
    const raw = sea.getRawAsset(`ui/${posixRel}`);
    return raw ? Buffer.from(raw) : null;
  } catch {
    return null;
  }
}

module.exports = {
  IS_SEA,
  APP_ROOT,
  BIN_DIR,
  DATA_DIR,
  UI_DIR,
  ensureRuntimeDirs,
  readUiAsset
};
