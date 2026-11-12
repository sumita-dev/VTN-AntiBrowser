/**
 * VNT-Browser Config Builder (`src/core/config-builder.js`)
 * Writes the encrypted `StaticConfig.enc`, `DynamicConfig.enc`, `WebGLFP.enc`,
 * pre-seeds `Default/Preferences` (Geolocation permission auto-grant, crash bubble suppression),
 * cleans stale `SingletonLock`, and constructs the exact CLI argument array for `chrome.exe`.
 */

const fs = require('fs');
const path = require('path');
const { encryptConfig, decryptConfig } = require('./cipher');
const { validateAndHealFingerprint } = require('./fingerprint-gen');

/**
 * Cleans stale Chromium lock files in `userDataDir` when no process is actively holding it.
 *
 * @param {string} userDataDir
 */
function cleanStaleLocks(userDataDir) {
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
  for (const lf of lockFiles) {
    const p = path.join(userDataDir, lf);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // Ignore if locked by a live process
      }
    }
  }
}

/**
 * Pre-populates `Default/Preferences` so that:
 * 1. `profile.default_content_setting_values.geolocation = 1` (Allows `navigator.geolocation`
 *    to return the spoofed `DynamicConfig.Geoposition` coordinates immediately without blocking).
 * 2. `profile.exit_type = "Normal"` and `profile.exited_cleanly = true` (Prevents the
 *    "Restore pages? Chrome didn't shut down correctly" popup bar).
 * 3. `intl.accept_languages` matches `--protected-acceptlang`.
 *
 * @param {string} userDataDir
 * @param {Object} fp
 */
function ensureDefaultPreferences(userDataDir, fp) {
  const defaultDir = path.join(userDataDir, 'Default');
  fs.mkdirSync(defaultDir, { recursive: true });
  const prefsPath = path.join(defaultDir, 'Preferences');

  let prefs = {};
  if (fs.existsSync(prefsPath)) {
    try {
      prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    } catch {
      prefs = {};
    }
  }

  if (!prefs.profile || typeof prefs.profile !== 'object') prefs.profile = {};
  prefs.profile.exit_type = 'Normal';
  prefs.profile.exited_cleanly = true;

  if (!prefs.profile.default_content_setting_values || typeof prefs.profile.default_content_setting_values !== 'object') {
    prefs.profile.default_content_setting_values = {};
  }
  // 1 = Allow geolocation so C++ hook (`fileOff 136617936`) returns spoofed coords without prompt
  prefs.profile.default_content_setting_values.geolocation = 1;
  // 2 = Block notifications prompt by default unless overridden
  prefs.profile.default_content_setting_values.notifications = 2;

  if (!prefs.intl || typeof prefs.intl !== 'object') prefs.intl = {};
  const langs = (fp.switches && fp.switches.Langs) || 'en-US,en';
  prefs.intl.accept_languages = langs;

  if (!prefs.webrtc || typeof prefs.webrtc !== 'object') prefs.webrtc = {};
  prefs.webrtc.ip_handling_policy = 'default_public_interface_only';

  fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf8');
}

/**
 * Builds all encrypted config files on disk and returns the CLI arguments for `chrome.exe`.
 *
 * @param {Object} options
 * @param {string} options.userDataDir - Target profile directory on disk
 * @param {Object} options.fingerprint - Profile fingerprint object
 * @param {number} [options.remoteDebuggingPort] - CDP port
 * @param {string} [options.proxyServer] - e.g. `socks5://127.0.0.1:24001` or `http://1.2.3.4:8080`
 * @param {boolean} [options.headless=false] - Run in `--headless=new` mode
 * @param {string} [options.startUrl] - Initial URL to open
 * @param {string} [options.cookiesFile] - Optional path to JSON cookies file to import (`--protected-cookiesfile`)
 * @param {string} [options.customIcon] - Optional path to `.ico` file (`--protected-customicon`)
 * @returns {{
 *   args: string[],
 *   warnings: string[],
 *   paths: { staticConfigPath: string, dynamicConfigPath: string, webglFpPath: string }
 * }}
 */
function buildProfileLaunchArtifacts(options) {
  const { userDataDir } = options;
  if (!userDataDir) {
    throw new Error('buildProfileLaunchArtifacts requires options.userDataDir');
  }

  fs.mkdirSync(userDataDir, { recursive: true });
  cleanStaleLocks(userDataDir);

  const { fp, warnings } = validateAndHealFingerprint(options.fingerprint || {});
  ensureDefaultPreferences(userDataDir, fp);

  const staticConfigPath = path.join(userDataDir, 'StaticConfig.enc');
  const dynamicConfigPath = path.join(userDataDir, 'DynamicConfig.enc');
  const webglFpPath = path.join(userDataDir, 'WebGLFP.enc');

  fs.writeFileSync(staticConfigPath, encryptConfig(fp.staticConfig), 'utf8');
  fs.writeFileSync(dynamicConfigPath, encryptConfig(fp.dynamicConfig), 'utf8');
  fs.writeFileSync(webglFpPath, encryptConfig(fp.webglFp), 'utf8');

  const switches = Object.assign({}, fp.switches);
  if (options.cookiesFile && fs.existsSync(options.cookiesFile)) {
    switches.CookiesFile = options.cookiesFile;
  }
  if (options.customIcon && fs.existsSync(options.customIcon)) {
    switches.CustomIcon = options.customIcon;
  }

  const protectedFlags = [];
  for (const [key, val] of Object.entries(switches)) {
    if (val !== undefined && val !== null && String(val).length > 0) {
      protectedFlags.push(`--protected-${key.toLowerCase()}=${val}`);
    }
  }

  const args = [
    `--user-data-dir=${userDataDir}`,
    `--protected-staticconfig=${staticConfigPath}`,
    `--protected-dynamicconfig=${dynamicConfigPath}`,
    `--protected-webglfp=${webglFpPath}`,
    ...protectedFlags
  ];

  if (fp.userAgent) {
    args.push(`--user-agent=${fp.userAgent}`);
  }
  if (options.remoteDebuggingPort !== undefined && options.remoteDebuggingPort !== null) {
    args.push(`--remote-debugging-port=${options.remoteDebuggingPort}`);
    args.push('--remote-allow-origins=*');
  }
  if (options.proxyServer) {
    args.push(`--proxy-server=${options.proxyServer}`);
  }
  if (options.headless) {
    args.push('--headless=new');
  }

  // Stability & anti-leak flags
  args.push(
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--metrics-recording-only',
    '--password-store=basic'
  );

  const startUrl = options.startUrl || (fp.staticConfig && fp.staticConfig.NewTabURL) || 'about:blank';
  args.push(startUrl);

  return {
    args,
    warnings,
    healedFingerprint: fp,
    paths: {
      staticConfigPath,
      dynamicConfigPath,
      webglFpPath
    }
  };
}

/**
 * Dynamically updates `DynamicConfig.enc` on disk (e.g. after pre-flight GeoIP lookup).
 *
 * @param {string} userDataDir
 * @param {Object} dynamicPatch
 */
function updateDynamicConfigOnDisk(userDataDir, dynamicPatch) {
  const dynamicConfigPath = path.join(userDataDir, 'DynamicConfig.enc');
  let existing = { _v: '1' };
  if (fs.existsSync(dynamicConfigPath)) {
    try {
      existing = decryptConfig(fs.readFileSync(dynamicConfigPath, 'utf8'));
    } catch {}
  }
  const merged = Object.assign(existing, dynamicPatch);
  fs.writeFileSync(dynamicConfigPath, encryptConfig(merged), 'utf8');
}

module.exports = {
  cleanStaleLocks,
  ensureDefaultPreferences,
  buildProfileLaunchArtifacts,
  updateDynamicConfigOnDisk
};
