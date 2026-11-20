/**
 * VTN Anti-Browser Version & Semver Utilities (`src/core/version.js`)
 * Single source of truth for runtime application version (safe in Node SEA bundles).
 */

const APP_VERSION = '1.1.0';

/**
 * Parses a semver string (e.g. "v1.2.3", "1.2", "1.2.3-beta.1") into [major, minor, patch].
 *
 * @param {string} v
 * @returns {[number, number, number]}
 */
function parseSemver(v) {
  const cleaned = String(v || '0.0.0')
    .trim()
    .replace(/^[vV]/, '')
    .split(/[-+]/)[0];
  const parts = cleaned.split('.').map((seg) => {
    const n = Number.parseInt(seg, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Compares two semver strings.
 * Returns:
 *  -1 if a < b
 *   0 if a === b
 *   1 if a > b
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

module.exports = {
  APP_VERSION,
  parseSemver,
  compareSemver
};
