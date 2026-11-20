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
const { IS_SEA, BIN_DIR, DATA_DIR, ensureRuntimeDirs } = require('./core/paths');

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
 * Prompts the user with a native Windows Yes/No MessageBox when closing the Manager UI
 * while one or more browser profiles are still active.
 * Defaults to `false` (keep profiles alive) on No or on any spawn/dialog error.
 *
 * @param {number} activeCount
 * @returns {Promise<boolean>}
 */
function confirmCloseActiveProfiles(activeCount) {
  const count = Number(activeCount) || 0;
  const message = `Hiện có ${count} profile trình duyệt đang hoạt động.\nBạn có muốn tắt toàn bộ các profile đang chạy và thoát ứng dụng không?`;
  const msgBase64 = Buffer.from(message, 'utf8').toString('base64');
  const psScript = [
    'Add-Type -AssemblyName System.Windows.Forms',
    `$msg = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${msgBase64}'))`,
    '$res = [System.Windows.Forms.MessageBox]::Show($msg, "VTN Anti-Browser", [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question, [System.Windows.Forms.MessageBoxDefaultButton]::Button2, [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly)',
    'if ($res -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 } else { exit 1 }'
  ].join('; ');
  const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');

  return new Promise((resolve) => {
    try {
      const ps = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encodedCommand],
        { stdio: 'ignore', windowsHide: true }
      );
      ps.once('error', () => resolve(false));
      ps.once('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Launches the VNT-Browser Manager Dashboard inside a standalone `--app` desktop window.
 * Ensures Chromium 151 kernel is present before launching UI window.
 * If missing, attempts auto-bootstrap from Cloudflare R2.
 * If still unavailable, falls back gracefully to opening system default browser without crashing.
 *
 * @param {string} dashboardUrl
 * @param {BrowserManager} browserManager
 * @param {Object} [launchOpts={}]
 * @returns {Promise<Object>}
 */
async function launchAppWindowWithFallback(dashboardUrl, browserManager, launchOpts = {}) {
  const parsedUrl = new URL(dashboardUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Invalid protocol for dashboardUrl: "${parsedUrl.protocol}". Only "http:" and "https:" are allowed.`);
  }

  let chromeExe = browserManager.chromeExe;

  // 1. Check if kernel is already present on local disk
  if (!fs.existsSync(chromeExe)) {
    console.log('[VTN Anti-Browser] Chromium 151 kernel not found locally at:', chromeExe);

    // 2. Try auto-bootstrap from Cloudflare R2 if configured
    if (browserManager.cloudSync && browserManager.cloudSync.isEnabled()) {
      try {
        console.log('[VTN Anti-Browser] Checking Cloudflare R2 for Chromium 151 kernel package...');
        const cloudStatus = await browserManager.cloudSync.hasKernelOnCloud();
        if (cloudStatus && cloudStatus.exists) {
          console.log('[VTN Anti-Browser] Found kernel package on R2. Downloading & unpacking system/bin_151-0007.tar.gz...');
          const binBaseDir = BIN_DIR;
          const dlRes = await browserManager.cloudSync.downloadKernel(binBaseDir);
          if (dlRes && dlRes.chromeExe && fs.existsSync(dlRes.chromeExe)) {
            chromeExe = dlRes.chromeExe;
            browserManager.chromeExe = dlRes.chromeExe;
            console.log('[VTN Anti-Browser] ✓ Chromium 151 kernel downloaded and unpacked successfully.');
          }
        } else {
          console.log('[VTN Anti-Browser] Kernel package system/bin_151-0007.tar.gz not found on Cloudflare R2.');
        }
      } catch (dlErr) {
        console.warn('[VTN Anti-Browser] Auto-bootstrap from R2 failed:', dlErr.message);
      }
    }
  }

  // 3. If kernel exists now, open native --app window
  if (fs.existsSync(chromeExe)) {
    return openManagerAppWindow(parsedUrl.href, chromeExe, launchOpts);
  }

  // 4. Smart Fallback: Open dashboard in default Windows browser (rundll32 url.dll,FileProtocolHandler)
  console.log('[VTN Anti-Browser] ------------------------------------------------------------');
  console.log('[VTN Anti-Browser] [SMART FALLBACK] Chromium native kernel not found locally or on R2.');
  console.log(`[VTN Anti-Browser] Opening Dashboard in default Windows system browser: ${parsedUrl.href}`);
  console.log('[VTN Anti-Browser] Tip: Open Settings > Cloudflare R2 to enter your Sync Key or download the kernel.');
  console.log('[VTN Anti-Browser] ------------------------------------------------------------');

  try {
    const fallbackProc = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', parsedUrl.href], {
      stdio: 'ignore',
      detached: true
    });
    fallbackProc.unref();
  } catch (spawnErr) {
    console.error('[VTN Anti-Browser] Failed to launch default system browser:', spawnErr.message);
  }

  return {
    process: null,
    fallback: true,
    dashboardUrl: parsedUrl.href,
    cdpPort: null,
    pageWsEndpoint: null,
    browserWsEndpoint: null
  };
}
async function openManagerAppWindow(dashboardUrl, chromeExe, launchOpts = {}) {
  const parsedUrl = new URL(dashboardUrl);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Invalid protocol for dashboardUrl: "${parsedUrl.protocol}". Only "http:" and "https:" are allowed.`);
  }

  const exe = chromeExe || path.join(BIN_DIR, '151-0007', 'chrome.exe');
  if (!fs.existsSync(exe)) {
    if (launchOpts.fallbackToSystemBrowser) {
      console.log(`[VTN Anti-Browser] Native kernel not found. Opening default system browser at: ${parsedUrl.href}`);
      try {
        const fallbackProc = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', parsedUrl.href], {
          stdio: 'ignore',
          detached: true
        });
        fallbackProc.unref();
      } catch {}
      return {
        process: null,
        fallback: true,
        dashboardUrl: parsedUrl.href,
        cdpPort: null,
        pageWsEndpoint: null,
        browserWsEndpoint: null
      };
    }
    throw new Error(`Chromium executable not found at: ${exe}`);
  }

  const uiProfileDir = launchOpts.userDataDir || path.join(DATA_DIR, '_manager_ui_profile');
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
    '--window-size=1500,920',
    '--disable-features=Translate',
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
  ensureRuntimeDirs();
  const port = options.port !== undefined ? options.port : PORT;
  const db = new ProfileDatabase(options.dbPath);
  const browserManager = new BrowserManager({
    db,
    chromeExe: options.chromeExe,
    profilesDir: options.profilesDir
  });

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
          appWindow = await launchAppWindowWithFallback(
            `http://${HOST}:${port}`,
            browserManager,
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
      appWindow = await launchAppWindowWithFallback(
        dashboardUrl,
        browserManager,
        {
          headless: Boolean(options.headlessAppWindow),
          attached: Boolean(options.attachedAppWindow)
        }
      );
    } catch (err) {
      console.error('[VTN Anti-Browser] Failed to spawn UI window:', err.message);
    }
  }

  let shutdownPromise = null;
  let activeProfileWatchCleanup = null;
  let managerExitCleanup = null;

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (activeProfileWatchCleanup) {
        try { activeProfileWatchCleanup(); } catch {}
        activeProfileWatchCleanup = null;
      }
      if (managerExitCleanup) {
        try { managerExitCleanup(); } catch {}
        managerExitCleanup = null;
      }

      let safetyTimer = null;
      const timeoutPromise = new Promise((resolve) => {
        safetyTimer = setTimeout(() => {
          console.warn('[VTN Anti-Browser] Shutdown safety timeout (3000ms) reached; forcing exit cleanup.');
          resolve();
        }, 3000);
        if (typeof safetyTimer.unref === 'function') {
          safetyTimer.unref();
        }
      });

      const performShutdown = async () => {
        if (appWindow && appWindow.process) {
          try { appWindow.process.kill(); } catch {}
        }
        await browserManager.closeAll();
        if (server) {
          if (typeof server.closeAllConnections === 'function') {
            server.closeAllConnections();
          }
          await new Promise((resolve) => server.close(() => resolve()));
        }
      };

      try {
        await Promise.race([performShutdown(), timeoutPromise]);
      } finally {
        clearTimeout(safetyTimer);
        try { db.db.close(); } catch {}
      }
    })();
    return shutdownPromise;
  };

  const sigHandler = async () => {
    await shutdown();
    process.exit(0);
  };
  process.once('SIGINT', sigHandler);
  process.once('SIGTERM', sigHandler);

  const isAppWindowMode = (options.openAppWindow || process.argv.includes('--app-window')) && !options.headlessAppWindow;
  const shouldWatchAppWindowExit = isAppWindowMode && (require.main === module || options.exitOnAppWindowClose !== false);

  if (shouldWatchAppWindowExit && appWindow && appWindow.process && !appWindow.fallback && !appWindow.handedOff) {
    let managerCloseHandled = false;
    const confirmFn = typeof options.confirmCloseProfiles === 'function'
      ? options.confirmCloseProfiles
      : confirmCloseActiveProfiles;

    const finishAndExit = async () => {
      await shutdown();
      if (options.exitProcess !== false) {
        process.exit(0);
      }
    };

    const onManagerClosed = async () => {
      if (managerCloseHandled || shutdownPromise) return;
      managerCloseHandled = true;

      if (browserManager.activeSessions.size === 0) {
        await finishAndExit();
        return;
      }

      let shouldCloseAll = false;
      try {
        shouldCloseAll = Boolean(await confirmFn(browserManager.activeSessions.size));
      } catch {
        shouldCloseAll = false;
      }

      if (shutdownPromise) return;

      if (shouldCloseAll || browserManager.activeSessions.size === 0) {
        await finishAndExit();
        return;
      }

      const onProfileState = async () => {
        if (browserManager.activeSessions.size === 0) {
          browserManager.off('profile:state', onProfileState);
          activeProfileWatchCleanup = null;
          await finishAndExit();
        }
      };
      activeProfileWatchCleanup = () => browserManager.off('profile:state', onProfileState);
      browserManager.on('profile:state', onProfileState);

      if (browserManager.activeSessions.size === 0) {
        browserManager.off('profile:state', onProfileState);
        activeProfileWatchCleanup = null;
        await finishAndExit();
      }
    };

    if (appWindow.process.exitCode !== null || appWindow.process.signalCode !== null) {
      void onManagerClosed();
    } else {
      appWindow.process.once('exit', onManagerClosed);
      managerExitCleanup = () => {
        try { appWindow.process.off('exit', onManagerClosed); } catch {}
      };
    }
  }

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
  const hasNoWindow = process.argv.includes('--no-window');
  const shouldOpenApp = process.argv.includes('--app-window') || (IS_SEA && !hasNoWindow);
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
  launchAppWindowWithFallback,
  checkExistingVntBrowser,
  confirmCloseActiveProfiles
};
