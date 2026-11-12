/**
 * VNT-Browser Process & CDP Lifecycle Manager (`src/core/browser-manager.js`)
 * Coordinates launching `chrome.exe` (151.0.7922.109), binding `Tool.exe` (GOST) proxy tunnels,
 * performing optional pre-flight GeoIP synchronization, exposing CDP endpoints (`wsEndpoint`,
 * `debuggingPort`), and automatically cleaning up child processes on exit.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { buildProfileLaunchArtifacts } = require('./config-builder');
const { CloudSync } = require('./cloud-sync');
const {
  getFreeLocalPort,
  normalizeProxyConfig,
  startProxyTunnel,
  resolveGeoIp
} = require('./proxy-tunnel');

const DEFAULT_CHROME_EXE = path.resolve(__dirname, '..', '..', 'bin', '151-0007', 'chrome.exe');
const DEFAULT_PROFILES_DIR = path.resolve(__dirname, '..', '..', 'data', 'profiles');

function fetchCdpJson(port, endpoint = '/json/version', timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${endpoint}`, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('CDP request timeout'));
    });
  });
}

async function waitForCdpReady(port, maxWaitMs = 12000) {
  const start = Date.now();
  let candidate = null;
  while (Date.now() - start < maxWaitMs) {
    try {
      const versionInfo = await fetchCdpJson(port, '/json/version', 1000);
      const targets = await fetchCdpJson(port, '/json', 1000);
      const pageTarget = Array.isArray(targets) ? targets.find((t) => t.type === 'page') : null;
      if (versionInfo && versionInfo.webSocketDebuggerUrl) {
        candidate = {
          browserWsEndpoint: versionInfo.webSocketDebuggerUrl,
          pageWsEndpoint: pageTarget ? pageTarget.webSocketDebuggerUrl : null,
          browserVersion: versionInfo.Browser,
          userAgent: versionInfo['User-Agent']
        };
        // If page target is also ready, or after 1.5s grace period, return immediately
        if (candidate.pageWsEndpoint || (Date.now() - start > 1500)) {
          return candidate;
        }
      }
    } catch {
      // Wait and retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (candidate) return candidate;
  throw new Error(`Timed out waiting for Chrome CDP on port ${port}`);
}

class BrowserManager {
  constructor(options = {}) {
    this.chromeExe = options.chromeExe || DEFAULT_CHROME_EXE;
    this.profilesDir = options.profilesDir || DEFAULT_PROFILES_DIR;
    this.db = options.db || null;
    this.cloudSync = options.cloudSync !== undefined ? options.cloudSync : new CloudSync();
    /** @type {Map<string, Object>} */
    this.activeSessions = new Map();
    /** @type {Map<string, Promise<void>>} */
    this._syncingPromises = new Map();
    fs.mkdirSync(this.profilesDir, { recursive: true });
  }

  _syncAndReleaseLock(profileId) {
    const id = String(profileId);
    if (this._syncingPromises.has(id)) {
      return this._syncingPromises.get(id);
    }

    const syncPromise = (async () => {
      try {
        if (this.cloudSync && this.cloudSync.isEnabled()) {
          try {
            await this.cloudSync.uploadProfileData(id, this.db, this.profilesDir);
          } catch (err) {
            console.error(`[BrowserManager] Cloud upload error on close for ${id}:`, err.message);
          } finally {
            try {
              await this.cloudSync.releaseLock(id);
            } catch (err) {
              console.error(`[BrowserManager] Lock release error on close for ${id}:`, err.message);
            }
          }
        }
      } finally {
        this._syncingPromises.delete(id);
      }
    })();

    this._syncingPromises.set(id, syncPromise);
    return syncPromise;
  }

  /**
   * Lists all currently running profile sessions.
   */
  listActiveSessions() {
    const list = [];
    for (const [profileId, sess] of this.activeSessions.entries()) {
      list.push({
        profileId,
        pid: sess.chromeProcess ? sess.chromeProcess.pid : null,
        debuggingPort: sess.debuggingPort,
        browserWsEndpoint: sess.browserWsEndpoint,
        pageWsEndpoint: sess.pageWsEndpoint,
        proxyPort: sess.proxyTunnel ? sess.proxyTunnel.localPort : null,
        startedAt: sess.startedAt,
        geoInfo: sess.geoInfo || null
      });
    }
    return list;
  }

  isRunning(profileId) {
    const id = String(profileId);
    const sess = this.activeSessions.get(id);
    if (!sess) return false;
    if (sess.chromeProcess && sess.chromeProcess.exitCode !== null) {
      this.activeSessions.delete(id);
      return false;
    }
    return true;
  }

  getSession(profileId) {
    const id = String(profileId);
    const sess = this.activeSessions.get(id);
    if (!sess) return null;
    if (sess.chromeProcess && sess.chromeProcess.exitCode !== null) {
      this.activeSessions.delete(id);
      return null;
    }
    return sess;
  }

  /**
   * Opens a browser profile, optionally resolving GeoIP via its configured proxy first.
   *
   * @param {string|Object} profileOrId - Profile ID (fetched from DB) or direct profile object
   * @param {Object} [launchOpts={}]
   * @param {boolean} [launchOpts.headless=false]
   * @param {string} [launchOpts.startUrl]
   * @param {boolean} [launchOpts.autoGeoIp]
   * @returns {Promise<Object>}
   */
  async openProfile(profileOrId, launchOpts = {}) {
    let profile = typeof profileOrId === 'object' ? profileOrId : null;
    if (!profile && this.db) {
      profile = this.db.getProfile(String(profileOrId));
    }
    if (!profile) {
      throw new Error(`Profile not found: ${profileOrId}`);
    }

    const profileId = String(profile.id);
    if (this.activeSessions.has(profileId)) {
      const existing = this.activeSessions.get(profileId);
      if (existing.chromeProcess && existing.chromeProcess.exitCode !== null) {
        this.activeSessions.delete(profileId);
      } else {
        return {
          alreadyRunning: true,
          profileId,
          pid: existing.chromeProcess ? existing.chromeProcess.pid : null,
          debuggingPort: existing.debuggingPort,
          browserWsEndpoint: existing.browserWsEndpoint,
          pageWsEndpoint: existing.pageWsEndpoint,
          userDataDir: existing.userDataDir
        };
      }
    }

    if (!fs.existsSync(this.chromeExe)) {
      throw new Error(`Chromium 151 kernel executable not found at: ${this.chromeExe}`);
    }

    const userDataDir = launchOpts.userDataDir || path.join(this.profilesDir, profileId);
    fs.mkdirSync(userDataDir, { recursive: true });

    // 0. Cloud Sync: Distributed Lock check and auto-download latest profile data from R2
    if (this.cloudSync && this.cloudSync.isEnabled() && !launchOpts.skipCloudSync) {
      await this.cloudSync.acquireLock(profileId);
      try {
        await this.cloudSync.downloadProfileData(profileId, this.db, this.profilesDir);
        if (this.db) {
          const fresh = this.db.getProfile(profileId);
          if (fresh) profile = fresh;
        }
      } catch (err) {
        console.error(`[BrowserManager] Cloud download warning for ${profileId}:`, err.message);
      }
    }

    // 1. Setup Proxy Tunnel if proxy is configured
    let proxyTunnel = null;
    let chromeProxyServer = null;
    const normProxy = normalizeProxyConfig(launchOpts.proxyConfig || profile.proxyConfig);
    if (normProxy) {
      proxyTunnel = await startProxyTunnel(normProxy);
      chromeProxyServer = proxyTunnel.chromeProxyArg;
    }

    let chromeProcess;
    let debuggingPort;
    let geoInfo = null;
    let warnings = [];
    let healedFingerprint = null;
    let paths = null;

    try {
      // 2. Clone fingerprint and optionally synchronize GeoIP (TimeZone, PublicIP, WebRTCAddress, Geoposition)
      const fp = JSON.parse(JSON.stringify(profile.fingerprint || {}));
      const shouldAutoGeo = launchOpts.autoGeoIp !== undefined ? launchOpts.autoGeoIp : Boolean(profile.autoGeoIp);

      if (shouldAutoGeo) {
        geoInfo = await resolveGeoIp(proxyTunnel ? proxyTunnel.localPort : null, 5000);
        if (geoInfo && geoInfo.ok) {
          if (!fp.switches) fp.switches = {};
          if (!fp.dynamicConfig) fp.dynamicConfig = {};
          fp.switches.TimeZone = geoInfo.timeZone;
          fp.switches.Langs = geoInfo.langs;
          fp.switches.AcceptLang = geoInfo.acceptLang;
          fp.dynamicConfig.TimeZone = geoInfo.timeZone;
          fp.dynamicConfig.PublicIP = geoInfo.ip;
          fp.dynamicConfig.WebRTCAddress = geoInfo.ip;
          fp.dynamicConfig.Geoposition = geoInfo.geoposition;
        }
      }

      // 3. Write Cookies import file if profile has cookies
      let cookiesFile = null;
      if (Array.isArray(profile.cookies) && profile.cookies.length > 0) {
        cookiesFile = path.join(userDataDir, 'ImportCookies.json');
        fs.writeFileSync(cookiesFile, JSON.stringify(profile.cookies, null, 2), 'utf8');
      }

      // 4. Allocate free CDP debugging port
      debuggingPort = launchOpts.debuggingPort || (await getFreeLocalPort());

      // 5. Build encrypted configs (`StaticConfig.enc`, `DynamicConfig.enc`, `WebGLFP.enc`) & CLI args
      const startUrl = launchOpts.startUrl || profile.startUrl || 'about:blank';
      const artifacts = buildProfileLaunchArtifacts({
        userDataDir,
        fingerprint: fp,
        remoteDebuggingPort: debuggingPort,
        proxyServer: chromeProxyServer,
        headless: Boolean(launchOpts.headless),
        startUrl,
        cookiesFile
      });
      warnings = artifacts.warnings;
      healedFingerprint = artifacts.healedFingerprint;
      paths = artifacts.paths;

      // 6. Spawn `chrome.exe` with stdin ignored
      chromeProcess = spawn(this.chromeExe, artifacts.args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: false,
        windowsHide: Boolean(launchOpts.headless)
      });
    } catch (err) {
      if (proxyTunnel && proxyTunnel.process) {
        try { proxyTunnel.process.kill(); } catch {}
      }
      if (this.cloudSync && this.cloudSync.isEnabled()) {
        try { await this.cloudSync.releaseLock(profileId); } catch {}
      }
      throw err;
    }

    const sessionRecord = {
      profileId,
      userDataDir,
      chromeProcess,
      proxyTunnel,
      debuggingPort,
      browserWsEndpoint: null,
      pageWsEndpoint: null,
      startedAt: new Date().toISOString(),
      geoInfo,
      warnings
    };

    this.activeSessions.set(profileId, sessionRecord);

    // Ensure automatic cleanup of GOST proxy tunnel and cloud sync when Chrome exits or errors
    const cleanup = () => {
      if (proxyTunnel && proxyTunnel.process) {
        try { proxyTunnel.process.kill(); } catch {}
      }
      this.activeSessions.delete(profileId);
      this._syncAndReleaseLock(profileId).catch(() => {});
    };
    chromeProcess.once('exit', cleanup);
    chromeProcess.on('error', cleanup);

    // 7. Wait for CDP readiness
    try {
      const cdpInfo = await waitForCdpReady(debuggingPort, 12000);
      sessionRecord.browserWsEndpoint = cdpInfo.browserWsEndpoint;
      sessionRecord.pageWsEndpoint = cdpInfo.pageWsEndpoint;
    } catch (err) {
      // Kill process if CDP failed to initialize
      await this.closeProfile(profileId);
      throw err;
    }

    if (this.db) {
      try {
        this.db.markOpened(profileId);
      } catch {}
    }

    return {
      alreadyRunning: false,
      profileId,
      pid: chromeProcess.pid,
      debuggingPort,
      browserWsEndpoint: sessionRecord.browserWsEndpoint,
      pageWsEndpoint: sessionRecord.pageWsEndpoint,
      userDataDir,
      warnings,
      geoInfo,
      configPaths: paths,
      appliedFingerprint: healedFingerprint
    };
  }

  /**
   * Closes a running browser profile and terminates its bound GOST tunnel.
   * On Windows, waits for chrome.exe to release file handles before resolving.
   *
   * @param {string} profileId
   * @returns {Promise<boolean>}
   */
  async closeProfile(profileId) {
    const id = String(profileId);
    const sess = this.activeSessions.get(id);
    if (!sess) return false;

    if (sess.proxyTunnel && sess.proxyTunnel.process) {
      try { sess.proxyTunnel.process.kill(); } catch {}
    }
    if (sess.chromeProcess) {
      await new Promise((resolve) => {
        if (sess.chromeProcess.exitCode !== null) return resolve();
        const t = setTimeout(resolve, 2000);
        sess.chromeProcess.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        try {
          sess.chromeProcess.kill();
        } catch {
          clearTimeout(t);
          resolve();
        }
      });
    }
    this.activeSessions.delete(id);
    await this._syncAndReleaseLock(id);
    return true;
  }

  /**
   * Closes all running browser profiles (e.g. on application shutdown).
   */
  async closeAll() {
    const ids = Array.from(this.activeSessions.keys());
    for (const id of ids) {
      await this.closeProfile(id);
    }
  }

  /**
   * Deletes a profile's user-data-dir from disk after ensuring it is closed.
   * Defends against path traversal attacks.
   */
  async purgeProfileDiskData(profileId) {
    await this.closeProfile(profileId);
    const idStr = String(profileId);
    const rootDir = path.resolve(this.profilesDir);
    const resolvedPath = path.resolve(this.profilesDir, idStr);
    if (!resolvedPath.startsWith(rootDir + path.sep)) {
      throw new Error(`Invalid profile ID: directory traversal detected (${idStr})`);
    }
    if (fs.existsSync(resolvedPath)) {
      try {
        fs.rmSync(resolvedPath, { recursive: true, force: true });
      } catch {}
    }
  }
}

module.exports = {
  BrowserManager,
  DEFAULT_CHROME_EXE,
  DEFAULT_PROFILES_DIR,
  fetchCdpJson,
  waitForCdpReady
};
