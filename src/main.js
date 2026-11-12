// noqa: debug-artifact-file
/**
 * VTN Anti-Browser Main Entrypoint (`src/main.js`)
 * Starts the SQLite database, BrowserManager, and Local HTTP Dashboard/API Server.
 * If `--app-window` is passed, launches the dashboard in a lightweight native Chromium `--app` window
 * with automated CDP initial navigation to prevent blank white page (`about:blank`) traps.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { ProfileDatabase } = require('./core/db');
const { BrowserManager, waitForCdpReady, fetchCdpJson } = require('./core/browser-manager');
const { createApiServer } = require('./api/server');
const { buildProfileLaunchArtifacts } = require('./core/config-builder');
const { generateFingerprint } = require('./core/fingerprint-gen');
const { getFreeLocalPort } = require('./core/proxy-tunnel');

const PORT = Number(process.env.VTN_PORT || process.env.VNT_PORT || 45678);
const HOST = process.env.VTN_HOST || process.env.VNT_HOST || '127.0.0.1';

/**
 * Checks if a live VTN Anti-Browser instance is already serving on the specified host and port.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs=2000]
 * @returns {Promise<boolean>}
 */
async function checkExistingVntBrowser(host, port, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://${host}:${port}/api/v1/status`, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.ok);
  } catch {
    return false;
  }
}

/**
 * Launches the VNT-Browser Manager Dashboard inside a standalone `--app` desktop window.
 * Configures launch artifacts with a dedicated UI profile, free CDP port, and performs
 * an active CDP Page.navigate to ensure the dashboard renders immediately without getting
 * intercepted or replaced with `about:blank`.
 *
 * @param {string} dashboardUrl
 * @param {string} [chromeExe]
 * @param {Object} [launchOpts={}]
 * @returns {Promise<Object>}
 */
async function openManagerAppWindow(dashboardUrl, chromeExe, launchOpts = {}) {
  const exe = chromeExe || path.resolve(__dirname, '..', 'bin', '151-0007', 'chrome.exe');
  if (!fs.existsSync(exe)) {
    throw new Error(`Chromium executable not found at: ${exe}`);
  }

  const uiProfileDir = launchOpts.userDataDir || path.resolve(__dirname, '..', 'data', '_manager_ui_profile');
  fs.mkdirSync(uiProfileDir, { recursive: true });

  const uiCdpPort = launchOpts.cdpPort || (await getFreeLocalPort());
  const fp = generateFingerprint({
    blueprintId: 'win_nvidia_rtx4090',
    newTabUrl: dashboardUrl,
    allowScanPorts: '0'
  });

  const artifacts = buildProfileLaunchArtifacts({
    userDataDir: uiProfileDir,
    fingerprint: fp,
    remoteDebuggingPort: uiCdpPort,
    startUrl: dashboardUrl,
    headless: Boolean(launchOpts.headless)
  });

  const args = [
    `--app=${dashboardUrl}`,
    '--window-size=1360,860',
    ...artifacts.args
  ];

  const uiProc = spawn(exe, args, {
    stdio: 'ignore',
    detached: !launchOpts.attached,
    windowsHide: Boolean(launchOpts.headless)
  });

  let procExited = false;
  uiProc.once('exit', () => { procExited = true; });

  uiProc.on('error', (err) => {
    console.error('[VTN Anti-Browser] Failed to spawn UI window:', err.message);
  });

  if (!launchOpts.attached) {
    uiProc.unref();
  }

  // If Chrome process immediately exits, it handed off to an already running instance
  await new Promise((r) => setTimeout(r, 600));
  if (procExited || uiProc.exitCode !== null) {
    return {
      process: uiProc,
      cdpPort: uiCdpPort,
      pageWsEndpoint: null,
      browserWsEndpoint: null,
      userDataDir: uiProfileDir,
      handedOff: true
    };
  }

  let pageWsEndpoint = null;
  let browserWsEndpoint = null;

  try {
    const cdpInfo = await waitForCdpReady(uiCdpPort, 10000);
    browserWsEndpoint = cdpInfo.browserWsEndpoint;
    pageWsEndpoint = cdpInfo.pageWsEndpoint;

    if (!pageWsEndpoint) {
      const targets = await fetchCdpJson(uiCdpPort, '/json', 2000);
      const pageTarget = Array.isArray(targets) ? targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : null;
      if (pageTarget) {
        pageWsEndpoint = pageTarget.webSocketDebuggerUrl;
      }
    }

    if (pageWsEndpoint) {
      await new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            try { ws.close(); } catch {}
            resolve();
          }
        }, 4000);

        const ws = new WebSocket(pageWsEndpoint);
        ws.onopen = () => {
          ws.send(JSON.stringify({
            id: 1,
            method: 'Page.navigate',
            params: { url: dashboardUrl }
          }));
        };
        ws.onmessage = (evt) => {
          const d = JSON.parse(evt.data);
          if (d.id === 1) {
            setTimeout(() => {
              if (!done) {
                done = true;
                clearTimeout(timer);
                try { ws.close(); } catch {}
                resolve();
              }
            }, 400);
          }
        };
        ws.onerror = () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve();
          }
        };
      });
    }
  } catch (err) {
    console.error('[VNT-Browser] Warning: Could not complete CDP navigation on app window:', err.message);
  }

  return {
    process: uiProc,
    cdpPort: uiCdpPort,
    pageWsEndpoint,
    browserWsEndpoint,
    userDataDir: uiProfileDir
  };
}

async function startVntBrowser(options = {}) {
  const port = options.port !== undefined ? options.port : PORT;
  const db = new ProfileDatabase(options.dbPath);
  const browserManager = new BrowserManager({
    db,
    chromeExe: options.chromeExe,
    profilesDir: options.profilesDir
  });

  // Seed 2 showcase profiles if database is completely empty
  if (db.listProfiles().length === 0) {
    db.createProfile({
      id: 'vnt_macos_m3',
      name: 'MacBook Pro M3 Max (Tokyo)',
      groupName: 'Workstation',
      startUrl: 'about:blank',
      fingerprintOverrides: {
        blueprintId: 'mac_apple_m3_max',
        hardwareConcurrency: '14',
        deviceMemory: '32',
        screenSize: '2560,1440',
        timeZone: 'Asia/Tokyo',
        langs: 'ja-JP,ja,en-US,en',
        acceptLang: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
        canvasMark: '581920',
        webglMark: '31',
        audioFp: '19',
        clientRectFp: '42'
      }
    });

    db.createProfile({
      id: 'vnt_win11_rtx4090',
      name: 'Windows 11 RTX 4090 (New York)',
      groupName: 'Ads US',
      startUrl: 'about:blank',
      fingerprintOverrides: {
        blueprintId: 'win_nvidia_rtx4090',
        hardwareConcurrency: '16',
        deviceMemory: '64',
        screenSize: '1920,1080',
        timeZone: 'America/New_York',
        langs: 'en-US,en',
        acceptLang: 'en-US,en;q=0.9',
        canvasMark: '894123',
        webglMark: '64',
        audioFp: '53',
        clientRectFp: '77'
      }
    });
  }

  const server = createApiServer({ db, browserManager });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => resolve());
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      const isAlreadyRunning = await checkExistingVntBrowser(HOST, port);
      if (isAlreadyRunning) {
        console.log(`[VTN Anti-Browser] Detected active VTN Anti-Browser instance running on http://${HOST}:${port}`);
        let appWindow = null;
        if (options.openAppWindow || process.argv.includes('--app-window')) {
          console.log('[VTN Anti-Browser] Opening App Window for existing instance...');
          appWindow = await openManagerAppWindow(
            `http://${HOST}:${port}`,
            browserManager.chromeExe,
            {
              headless: Boolean(options.headlessAppWindow),
              attached: Boolean(options.attachedAppWindow)
            }
          );
        }
        return {
          url: `http://${HOST}:${port}`,
          port,
          db,
          browserManager,
          server: null,
          appWindow,
          isExistingInstance: true,
          shutdown: async () => {
            if (appWindow && appWindow.process) {
              try { appWindow.process.kill(); } catch {}
            }
            try { db.db.close(); } catch {}
          }
        };
      }
    }
    throw err;
  }

  const actualPort = server.address().port;
  const dashboardUrl = `http://${HOST}:${actualPort}`;

  let appWindow = null;
  if (options.openAppWindow || process.argv.includes('--app-window')) {
    try {
      appWindow = await openManagerAppWindow(
        dashboardUrl,
        browserManager.chromeExe,
        {
          headless: Boolean(options.headlessAppWindow),
          attached: Boolean(options.attachedAppWindow)
        }
      );
    } catch (err) {
      console.error('[VTN Anti-Browser] Failed to spawn UI window:', err.message);
    }
  }

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    if (appWindow && appWindow.process) {
      try { appWindow.process.kill(); } catch {}
    }
    await browserManager.closeAll();
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    try { db.db.close(); } catch {}
  };

  const sigHandler = async () => {
    await shutdown();
    process.exit(0);
  };
  process.once('SIGINT', sigHandler);
  process.once('SIGTERM', sigHandler);

  return {
    url: dashboardUrl,
    port: actualPort,
    db,
    browserManager,
    server,
    appWindow,
    shutdown
  };
}

if (require.main === module) {
  const shouldOpenApp = process.argv.includes('--app-window');
  startVntBrowser({ openAppWindow: shouldOpenApp })
    .then((result) => {
      if (result.isExistingInstance) {
        console.log(`[VTN Anti-Browser] Connected to active instance at: ${result.url}`);
        process.exit(0);
      }
      console.log(`[VTN Anti-Browser] Antidetect Manager running at: ${result.url}`);
      console.log('[VTN Anti-Browser] Tip: Run "npm run start:app" to open as a native Desktop Window.');
    })
    .catch((err) => {
      console.error('[VTN Anti-Browser] Fatal startup error:', err);
      process.exit(1);
    });
}

module.exports = {
  startVntBrowser,
  openManagerAppWindow,
  checkExistingVntBrowser
};
