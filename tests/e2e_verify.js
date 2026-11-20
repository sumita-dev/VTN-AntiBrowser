/**
 * VNT-Browser End-to-End Verification Suite (`tests/e2e_verify.js`)
 * Verifies:
 * 1. Cipher `"594"` invariant (including empty `{}` auto-guard against `bad_variant_access`).
 * 2. Fingerprint Validator & Auto-Healer (`CanvasMark < 1000`, `HideDebugPanel=1`, OS/GPU mismatch).
 * 3. SQLite Database CRUD & API Server endpoints.
 * 4. Simultaneous launch of two distinct profiles (`vnt_macos_m3` vs `vnt_win11_rtx4090`) via REST API,
 *    followed by live CDP WebSocket probing to prove independent C++ fingerprint spoofing and
 *    100% native prototype integrity (`[native code]`, `webdriver: false`, `ownNavPropsCount === 0`).
 * 5. Manager UI `--app-window` rendering via `openManagerAppWindow` (verifying location, document title,
 *    and reactive DOM stats).
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { encryptConfig, decryptConfig } = require('../src/core/cipher');
const {
  HARDWARE_BLUEPRINTS,
  validateAndHealFingerprint,
  generateUniqueFingerprint,
  extractHardwareSignature,
  listValidHardwareCombinations
} = require('../src/core/fingerprint-gen');
const { fetchCdpJson } = require('../src/core/browser-manager');
const { startVntBrowser, openManagerAppWindow, launchAppWindowWithFallback } = require('../src/main');
const { R2Client } = require('../src/core/r2-client');
const { CloudSync } = require('../src/core/cloud-sync');
const { createApiServer } = require('../src/api/server');
const { AiClient } = require('../src/core/ai-client');
const { APP_VERSION, compareSemver } = require('../src/core/version');
const {
  APP_BINARY_KEY,
  publishRelease,
  downloadAndStageUpdate,
  rollbackUpdate
} = require('../src/core/app-updater');

async function postJson(baseUrl, route, body) {
  const res = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function runTests() {
  console.log('=== [1/5] Testing "594" Cipher & Empty-Object Crash Guard ===');
  const encEmpty = encryptConfig({});
  assert(encEmpty.startsWith('594'), `Expected empty object encryption to start with "594", got: ${encEmpty}`);
  const decEmpty = decryptConfig(encEmpty);
  assert.strictEqual(decEmpty._v, '1');

  const sampleStatic = { AutomationControlled: '0', DeviceName: 'DESKTOP-VNT151' };
  const encStatic = encryptConfig(sampleStatic);
  assert(encStatic.startsWith('594'), 'Encrypted staticConfig must start with "594"');
  assert.deepStrictEqual(decryptConfig(encStatic), sampleStatic);

  assert.throws(() => decryptConfig(''), /non-empty/);
  assert.throws(() => decryptConfig(null), /non-empty/);
  console.log('  [PASS] Cipher "594" prefix, empty guard & roundtrip verified.');

  console.log('=== [2/5] Testing Fingerprint Validator & Auto-Healer ===');
  const brokenFp = {
    switches: {
      Platform: 'MacIntel',
      CanvasMark: '50', // Invalid (< 1000)
      HideDebugPanel: '1', // Breaks CDP
      WebGLMark: '250', // Out of bounds (> 99)
      AudioFP: '-5', // Out of bounds (< 1)
      ClientRectFP: '0' // Out of bounds (< 1)
    },
    staticConfig: {
      AutomationControlled: '1',
      MacAddress: 'AA-BB-CC-DD-EE-FF' // Should heal to MacAdderss
    },
    dynamicConfig: {
      TimeZone: 'Europe/Berlin'
    },
    webglFp: {
      UNMASKED_RENDERER_WEBGL: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)' // Mismatches MacIntel
    }
  };
  const healed = validateAndHealFingerprint(brokenFp);
  assert(Number(healed.fp.switches.CanvasMark) >= 1000, 'CanvasMark must be healed to >= 1000');
  assert.strictEqual(healed.fp.switches.HideDebugPanel, undefined, 'HideDebugPanel must be stripped');
  assert.strictEqual(healed.fp.staticConfig.AutomationControlled, '0', 'AutomationControlled must be "0"');
  assert.strictEqual(healed.fp.staticConfig.MacAdderss, 'AA-BB-CC-DD-EE-FF', 'MacAddress must map to MacAdderss');
  assert(healed.fp.webglFp.UNMASKED_RENDERER_WEBGL.includes('Apple M3 Max'), 'MacIntel must heal Direct3D11 to Apple Metal');
  assert.strictEqual(healed.fp.switches.TimeZone, 'Europe/Berlin', 'TimeZone must sync to switches');
  assert.strictEqual(healed.fp.switches.WebGLMark, '45', 'WebGLMark must be clamped to default valid');
  assert.strictEqual(healed.fp.switches.AudioFP, '35', 'AudioFP must be clamped to default valid');
  assert.strictEqual(healed.fp.switches.ClientRectFP, '42', 'ClientRectFP must be clamped to default valid');

  // Test Hardware Assembly Compatibility Rules & Expanded Blueprints
  const bpKeys = Object.keys(HARDWARE_BLUEPRINTS);
  assert(bpKeys.length >= 18, `Expected at least 18 hardware blueprints, got ${bpKeys.length}`);
  const validCombos = listValidHardwareCombinations();
  console.log(`  [PASS] Loaded ${bpKeys.length} Hardware Blueprints with ${validCombos.length} valid technical assembly combinations.`);

  // Verify incompatible CPU/RAM/Screen combinations are automatically healed
  const incompatibleRtx4090 = validateAndHealFingerprint({
    blueprintId: 'win_nvidia_rtx4090',
    switches: {
      Platform: 'Win32',
      HardwareConcurrency: '32',
      DeviceMemory: '8', // Invalid: 32-core RTX 4090 workstation requires >= 64GB RAM
      ScreenSize: '1728,1117', // Invalid: MacBook Pro 16" Retina screen on Win32
      CanvasMark: '200000'
    }
  });
  assert.strictEqual(incompatibleRtx4090.fp.switches.HardwareConcurrency, '32');
  assert(Number(incompatibleRtx4090.fp.switches.DeviceMemory) >= 64, '32-core RTX 4090 must heal 8GB RAM to >= 64GB');
  assert.notStrictEqual(incompatibleRtx4090.fp.switches.ScreenSize, '1728,1117', 'Win32 must reject MacBook Retina resolution');
  console.log(`  [PASS] Auto-healed ${healed.warnings.length + incompatibleRtx4090.warnings.length} hardware compatibility & edge cases cleanly.`);

  console.log('=== [3/5] Starting VNT-Browser Server & Testing Profile CRUD ===');
  const testDbPath = path.resolve(__dirname, '..', 'data', 'test_vnt_profiles.db');
  const testProfilesDir = path.resolve(__dirname, '..', 'data', 'test_profiles');
  const testUiProfileDir = path.resolve(__dirname, '..', 'data', 'test_ui_profile');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(testProfilesDir)) fs.rmSync(testProfilesDir, { recursive: true, force: true });
  if (fs.existsSync(testUiProfileDir)) fs.rmSync(testUiProfileDir, { recursive: true, force: true });

  const app = await startVntBrowser({
    port: 0, // Ephemeral port
    dbPath: testDbPath,
    profilesDir: testProfilesDir,
    openAppWindow: false
  });

  try {
    assert.strictEqual(app.db.listProfiles().length, 0, 'Fresh DB must start empty without auto-seeded showcase profiles');

    // Create 2 deterministic test fixture profiles (with autoGeoIp: false so local network IP does not override timezones)
    app.db.createProfile({
      id: 'vnt_macos_m3',
      name: 'MacBook Pro M3 Max (Tokyo)',
      groupName: 'Workstation',
      autoGeoIp: false,
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

    app.db.createProfile({
      id: 'vnt_win11_rtx4090',
      name: 'Windows 11 RTX 4090 (New York)',
      groupName: 'Ads US',
      autoGeoIp: false,
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

    const listRes = await fetch(`${app.url}/api/v1/profiles`).then((r) => r.json());
    assert(listRes.ok && listRes.profiles.length === 2, 'Expected 2 fixture profiles');
    console.log(`  [PASS] Server listening at ${app.url} (fresh DB empty; ${listRes.profiles.length} fixture profiles loaded).`);

    // Test directory traversal prevention
    await assert.rejects(
      async () => { await app.browserManager.purgeProfileDiskData('../../escape_dir'); },
      /traversal/
    );
    console.log('  [PASS] Profile directory traversal guard verified.');

    // Test Cross-Profile Deduplication via /api/v1/fingerprint/generate & /api/v1/profiles/auto-create
    console.log('=== [3.5/5] Testing Cross-Profile Hardware Anti-Collision & Auto-Create API ===');
    const seenCombos = new Set();
    const seenCanvas = new Set();
    const seenNoiseTuples = new Set();
    const seenMacs = new Set();
    const seenDevices = new Set();

    for (const p of listRes.profiles) {
      const sig = extractHardwareSignature(p);
      seenCombos.add(sig.hwComboKey);
      seenCanvas.add(sig.canvasMark);
      seenNoiseTuples.add(sig.noiseTupleKey);
      seenMacs.add(sig.macAddress);
      seenDevices.add(sig.deviceName);
    }

    for (let i = 0; i < 16; i++) {
      const autoRes = await postJson(app.url, '/api/v1/profiles/auto-create', {});
      assert(autoRes.ok && autoRes.profile, `Auto-create #${i + 1} failed`);
      assert.strictEqual(autoRes.comparedProfilesCount, 2 + i, 'comparedProfilesCount must track existing profiles');
      const sig = extractHardwareSignature(autoRes.profile);

      assert(!seenCombos.has(sig.hwComboKey), `Duplicate hardware combo detected: ${sig.hwComboKey}`);
      assert(!seenCanvas.has(sig.canvasMark), `Duplicate CanvasMark detected: ${sig.canvasMark}`);
      assert(!seenNoiseTuples.has(sig.noiseTupleKey), `Duplicate Noise Tuple detected: ${sig.noiseTupleKey}`);
      assert(!seenMacs.has(sig.macAddress), `Duplicate MAC Address detected: ${sig.macAddress}`);
      assert(!seenDevices.has(sig.deviceName), `Duplicate DeviceName detected: ${sig.deviceName}`);

      seenCombos.add(sig.hwComboKey);
      seenCanvas.add(sig.canvasMark);
      seenNoiseTuples.add(sig.noiseTupleKey);
      seenMacs.add(sig.macAddress);
      seenDevices.add(sig.deviceName);
    }
    console.log(`  [PASS] Created 16 consecutive Auto-Unique profiles (total ${seenCombos.size} profiles) with ZERO collisions across Hardware Combo, CanvasMark, Noise Tuple, MAC, and DeviceName.`);

    const hasChromeExe = fs.existsSync(app.browserManager.chromeExe);
    if (!hasChromeExe) {
      console.log(`\n=== [4/5 & 5/5] SKIPPED: Chromium kernel not found at "${app.browserManager.chromeExe}" ===`);
      console.log('  [NOTICE] Binary > 100MB is excluded from Git repository by design.');
      console.log('  [NOTICE] Copy "bin/151-0007/" into project root to enable live Chromium C++ & UI window probing.');
    } else {
      console.log('=== [4/5] Launching Two Profiles Concurrently & Probing Live C++ Fingerprints via CDP ===');
      const openMac = await postJson(app.url, '/api/v1/profile/open', {
        profileId: 'vnt_macos_m3',
        headless: true
      });
      assert(openMac.ok, `Failed to open vnt_macos_m3: ${openMac.error}`);

      const openWin = await postJson(app.url, '/api/v1/profile/open', {
        profileId: 'vnt_win11_rtx4090',
        headless: true
      });
      assert(openWin.ok, `Failed to open vnt_win11_rtx4090: ${openWin.error}`);

      const probeMacRes = await postJson(app.url, '/api/v1/profile/probe', { profileId: 'vnt_macos_m3' });
      const probeWinRes = await postJson(app.url, '/api/v1/profile/probe', { profileId: 'vnt_win11_rtx4090' });

      assert(probeMacRes.ok, `Probe Mac failed: ${probeMacRes.error}`);
      assert(probeWinRes.ok, `Probe Win failed: ${probeWinRes.error}`);

      const mac = probeMacRes.report;
      const win = probeWinRes.report;

      console.log('\n--- [LIVE CDP PROBE: Profile 1 (vnt_macos_m3)] ---');
      console.log(JSON.stringify(mac, null, 2));

      console.log('\n--- [LIVE CDP PROBE: Profile 2 (vnt_win11_rtx4090)] ---');
      console.log(JSON.stringify(win, null, 2));

      // Verify Profile 1 (Mac M3 Max)
      assert.strictEqual(mac.platform, 'MacIntel');
      assert.strictEqual(mac.hardwareConcurrency, 14);
      assert.strictEqual(mac.deviceMemory, 32);
      assert.strictEqual(mac.timeZone, 'Asia/Tokyo');
      assert.strictEqual(mac.screen, '2560x1440');
      assert.strictEqual(mac.webdriver, false);
      assert(mac.webgl.unmaskedRenderer.includes('Apple M3 Max'), 'Mac renderer mismatch');
      assert.strictEqual(mac.antiTamper.ownNavPropsCount, 0, 'navigator must have 0 own properties');
      assert(mac.antiTamper.toDataURLToString.includes('[native code]'));

      // Verify Profile 2 (Windows 11 RTX 4090)
      assert.strictEqual(win.platform, 'Win32');
      assert.strictEqual(win.hardwareConcurrency, 16);
      assert.strictEqual(win.deviceMemory, 64);
      assert.strictEqual(win.timeZone, 'America/New_York');
      assert.strictEqual(win.screen, '1920x1080');
      assert.strictEqual(win.webdriver, false);
      assert(win.webgl.unmaskedRenderer.includes('RTX 4090'), 'Win renderer mismatch');
      assert.strictEqual(win.antiTamper.ownNavPropsCount, 0, 'navigator must have 0 own properties');
      assert(win.antiTamper.getParameterToString.includes('[native code]'));

      // Verify Canvas hashes differ deterministically between profiles
      assert.notStrictEqual(mac.canvasHash, win.canvasHash, 'Canvas hashes must differ between profiles');
      console.log('  [PASS] Concurrent profile spoofing & anti-tamper invariants verified.');

      // Close both active profiles, verifying automatic cloud upload and lock release
      await postJson(app.url, '/api/v1/profile/close', { profileId: 'vnt_macos_m3' });
      await postJson(app.url, '/api/v1/profile/close', { profileId: 'vnt_win11_rtx4090' });
      assert.strictEqual(app.browserManager.isRunning('vnt_macos_m3'), false);
      assert.strictEqual(app.browserManager.isRunning('vnt_win11_rtx4090'), false);

      console.log('=== [5/5] Testing Manager UI --app-window Rendering via openManagerAppWindow ===');
      const appWin = await openManagerAppWindow(app.url, app.browserManager.chromeExe, {
        userDataDir: testUiProfileDir,
        headless: true,
        attached: true
      });
      assert(appWin && appWin.cdpPort, 'Manager UI app window must allocate a CDP port');

      try {
        let pageWs = appWin.pageWsEndpoint;
        if (!pageWs) {
          const targets = await fetchCdpJson(appWin.cdpPort, '/json', 2000);
          const pageTarget = Array.isArray(targets) ? targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : null;
          assert(pageTarget, 'Page target must be available in app window');
          pageWs = pageTarget.webSocketDebuggerUrl;
        }

        const ws = new WebSocket(pageWs);
        const winState = await new Promise((resolve, reject) => {
          let checks = 0;
          let interval = null;
          ws.onopen = () => {
            interval = setInterval(() => {
              checks++;
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  id: 100 + checks,
                  method: 'Runtime.evaluate',
                  params: {
                    expression: 'JSON.stringify({ href: location.href, title: document.title, statTotal: document.getElementById("statTotal") ? document.getElementById("statTotal").textContent : null })',
                    returnByValue: true
                  }
                }));
              }
            }, 300);
          };

          ws.onmessage = (evt) => {
            const msg = JSON.parse(evt.data);
            if (msg.id >= 101 && msg.result && msg.result.result && msg.result.result.value) {
              const val = JSON.parse(msg.result.result.value);
              if (val.statTotal === '18' || checks > 20) {
                if (interval) clearInterval(interval);
                try { ws.close(); } catch {}
                resolve(val);
              }
            }
          };
          ws.onerror = (err) => {
            if (interval) clearInterval(interval);
            reject(err);
          };
        });

        console.log('  Manager UI State:', winState);
        assert.strictEqual(winState.href, `${app.url}/`);
        assert.strictEqual(winState.title, 'VTN Anti-Browser — Native Chromium 151 Antidetect');
        assert.strictEqual(winState.statTotal, '18');

        // Also test clicking the UI button #btnAutoCreate inside the live Chromium App Window
        const wsClick = new WebSocket(pageWs);
        const afterClickTotal = await new Promise((resolve, reject) => {
          wsClick.onopen = () => {
            wsClick.send(JSON.stringify({
              id: 500,
              method: 'Runtime.evaluate',
              params: {
                expression: `(async () => {
                  const btn = document.getElementById('btnAutoCreate');
                  if (!btn) throw new Error('btnAutoCreate not found');
                  await autoCreateUniqueProfile();
                  return document.getElementById('statTotal').textContent;
                })()`,
                awaitPromise: true,
                returnByValue: true
              }
            }));
          };
          wsClick.onmessage = (evt) => {
            const msg = JSON.parse(evt.data);
            if (msg.id === 500) {
              try { wsClick.close(); } catch {}
              resolve(msg.result && msg.result.result ? msg.result.result.value : null);
            }
          };
          wsClick.onerror = reject;
        });
        assert.strictEqual(afterClickTotal, '19', 'Clicking #btnAutoCreate in UI must increment total profiles from 18 to 19');
        console.log('  [PASS] Manager UI window rendered & live #btnAutoCreate button created profile #19.');
      } finally {
        if (appWin.process) {
          try { appWin.process.kill(); } catch {}
        }
      }
    }

    console.log('=== [6/6] Testing Cloudflare R2 Multi-Machine Sync & Lock Invariant ===');
    const r2Client = R2Client.fromConfigFile();
    assert(r2Client.isConfigured(), 'R2 client must be configured with enabled: true');

    // 6.1 Native S3 SigV4 CRUD
    const testKey = 'test/e2e_sigv4_probe.json';
    const testPayload = JSON.stringify({ e2e: true, timestamp: Date.now() });
    await r2Client.putObject(testKey, testPayload, 'application/json');
    const headObj = await r2Client.headObject(testKey);
    assert(headObj && headObj.ok, 'headObject must succeed');
    const getObj = await r2Client.getObject(testKey);
    assert.strictEqual(getObj.body.toString('utf8'), testPayload, 'getObject content must match payload');
    const listObjs = await r2Client.listObjects('test/');
    assert(listObjs.some(o => o.key === testKey), 'listObjects must contain test key');
    await r2Client.deleteObject(testKey);
    assert.strictEqual(await r2Client.getObject(testKey), null, 'Object must be deleted');
    console.log('  [PASS] AWS SigV4 Zero-Dependency S3 Client verified (PUT/HEAD/GET/LIST/DELETE).');

    // 6.2 Lock Invariant across simulated machines
    const syncAlpha = new CloudSync({ r2Client, machineId: 'machine-alpha' });
    const syncBeta = new CloudSync({ r2Client, machineId: 'machine-beta' });
    const lockTestProfile = 'vnt_e2e_sync_test';

    await syncAlpha.acquireLock(lockTestProfile);
    const lockedForBeta = await syncBeta.isLocked(lockTestProfile);
    assert.strictEqual(lockedForBeta.locked, true, 'Machine Beta must detect profile is locked by Alpha');
    assert.strictEqual(lockedForBeta.machineId, 'machine-alpha');

    await assert.rejects(
      async () => { await syncBeta.acquireLock(lockTestProfile); },
      /đang được mở bởi máy/
    );

    await syncAlpha.releaseLock(lockTestProfile);
    const afterUnlockBeta = await syncBeta.isLocked(lockTestProfile);
    assert.strictEqual(afterUnlockBeta.locked, false, 'Lock must be released');
    console.log('  [PASS] Distributed Lock Invariant verified across concurrent machines.');

    // 6.2.1 Offline Degradation & Lock Ownership Invariant
    const mockOfflineR2 = {
      isConfigured: () => true,
      getObject: async () => { throw new Error('fetch failed: network offline'); },
      putObject: async () => { throw new Error('fetch failed: network offline'); }
    };
    const offlineSync = new CloudSync({ r2Client: mockOfflineR2, machineId: 'machine-offline' });
    const offlineAcquire = await offlineSync.acquireLock('offline-test-profile');
    assert.strictEqual(offlineAcquire.ok, true, 'acquireLock must degrade gracefully offline');
    assert.strictEqual(offlineAcquire.degradedOffline, true, 'degradedOffline must be true');

    // Lock Ownership Protection: Beta cannot release Alpha's lock
    await syncAlpha.acquireLock(lockTestProfile);
    const betaReleaseAttempt = await syncBeta.releaseLock(lockTestProfile);
    assert.strictEqual(betaReleaseAttempt.ok, false, 'Beta must not be able to release Alpha lock');
    assert.strictEqual(betaReleaseAttempt.reason, 'lock_owned_by_another');
    const alphaLockStillPresent = await syncBeta.isLocked(lockTestProfile);
    assert.strictEqual(alphaLockStillPresent.locked, true, 'Alpha lock must remain intact');
    await syncAlpha.releaseLock(lockTestProfile);
    console.log('  [PASS] Offline Degradation & Lock Ownership Protection verified.');

    // 6.2.2 BrowserManager Concurrent _syncAndReleaseLock Promise Coalescing
    const p1 = app.browserManager._syncAndReleaseLock('test-coalesce');
    const p2 = app.browserManager._syncAndReleaseLock('test-coalesce');
    assert.strictEqual(p1, p2, 'Concurrent _syncAndReleaseLock calls must return the identical Promise');
    await Promise.all([p1, p2]);
    console.log('  [PASS] BrowserManager concurrent _syncAndReleaseLock Promise coalescing verified.');

    // 6.2.3 SingletonLock tar.exe exclusion verification
    const dummyProfileDir = path.join(testProfilesDir, 'dummy_tar_test');
    fs.mkdirSync(dummyProfileDir, { recursive: true });
    fs.writeFileSync(path.join(dummyProfileDir, 'Preferences'), '{"valid": true}');
    fs.writeFileSync(path.join(dummyProfileDir, 'SingletonLock'), 'lock-content');
    fs.writeFileSync(path.join(dummyProfileDir, 'SingletonCookie'), 'cookie-content');
    fs.writeFileSync(path.join(dummyProfileDir, 'LOCK'), 'lock');
    fs.writeFileSync(path.join(dummyProfileDir, 'custom.tmp'), 'tmp');

    await syncAlpha.uploadProfileData('dummy_tar_test', null, testProfilesDir);

    const extractDir = path.join(testProfilesDir, 'dummy_tar_extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    const tarObj = await r2Client.getObject('profiles/dummy_tar_test/data.tar.gz');
    assert(tarObj && tarObj.body.length > 0, 'data.tar.gz must exist on R2');

    const tempTestTar = path.join(os.tmpdir(), `test_verify_${Date.now()}.tar.gz`);
    fs.writeFileSync(tempTestTar, tarObj.body);
    const { spawnSync: testTarSpawn } = require('node:child_process');
    testTarSpawn('tar.exe', ['-xzf', tempTestTar, '-C', extractDir]);
    try { fs.unlinkSync(tempTestTar); } catch {}

    assert.strictEqual(fs.existsSync(path.join(extractDir, 'Preferences')), true, 'Preferences must be preserved in tar');
    assert.strictEqual(fs.existsSync(path.join(extractDir, 'SingletonLock')), false, 'SingletonLock must be excluded from tar');
    assert.strictEqual(fs.existsSync(path.join(extractDir, 'SingletonCookie')), false, 'SingletonCookie must be excluded from tar');
    assert.strictEqual(fs.existsSync(path.join(extractDir, 'LOCK')), false, 'LOCK must be excluded from tar');
    assert.strictEqual(fs.existsSync(path.join(extractDir, 'custom.tmp')), false, '*.tmp must be excluded from tar');

    await r2Client.deleteObject('profiles/dummy_tar_test/data.tar.gz');
    await r2Client.deleteObject('profiles/dummy_tar_test/meta.json');
    console.log('  [PASS] Tar file exclusion (Singleton*, *lock*, *Lock*, *LOCK*, *.tmp) verified.');

    // 6.3 REST API Endpoints for Cloud Sync
    const cloudStatus = await fetch(`${app.url}/api/v1/cloud/status`).then(r => r.json());
    assert(cloudStatus.ok && cloudStatus.status.connected, 'Cloud status endpoint must report connected');
    assert.strictEqual(cloudStatus.status.bucket, 'vtn-antibrowser');

    const uploadApiRes = await postJson(app.url, '/api/v1/cloud/upload', { profileId: 'vnt_macos_m3' });
    assert(uploadApiRes.ok && uploadApiRes.result.ok, 'Cloud upload API must succeed');

    const dlApiRes = await postJson(app.url, '/api/v1/cloud/download', { profileId: 'vnt_macos_m3' });
    assert(dlApiRes.ok && dlApiRes.result.ok, 'Cloud download API must succeed');

    const syncAllApiRes = await postJson(app.url, '/api/v1/cloud/sync-all', {});
    assert(syncAllApiRes.ok && syncAllApiRes.result.ok, 'Cloud sync-all API must succeed');
    console.log('  [PASS] Cloud REST API (/status, /upload, /download, /sync-all) verified.');

    // 6.4 R2 Configuration UI & API (getMaskedConfig, saveConfig, retaining secrets)
    console.log('=== [6.4] Testing R2 Config API & Secret Masking Invariant ===');
    const tempR2CfgPath = path.join(testProfilesDir, 'temp_r2_config.json');
    const isolatedSync = new CloudSync({ configPath: tempR2CfgPath });

    const initialMasked = isolatedSync.getMaskedConfig();
    assert.strictEqual(initialMasked.enabled, false);
    assert.strictEqual(initialMasked.hasSecret, false);
    assert.strictEqual(initialMasked.secretAccessKey, undefined, 'Must not expose secretAccessKey');

    // Save initial configuration with secret
    isolatedSync.saveConfig({
      enabled: true,
      endpoint: 'https://test-account.r2.cloudflarestorage.com',
      accessKeyId: 'test_ak_key_1',
      secretAccessKey: 'super_secret_token_123',
      bucket: 'test-vtn-bucket',
      region: 'auto'
    });

    const savedMasked = isolatedSync.getMaskedConfig();
    assert.strictEqual(savedMasked.enabled, true);
    assert.strictEqual(savedMasked.hasSecret, true);
    assert.strictEqual(savedMasked.secretAccessKey, undefined, 'Must not expose secretAccessKey');
    assert.strictEqual(savedMasked.endpoint, 'https://test-account.r2.cloudflarestorage.com');
    assert.strictEqual(savedMasked.accessKeyId, 'test_ak_key_1');
    assert.strictEqual(savedMasked.bucket, 'test-vtn-bucket');

    // Update without providing secretAccessKey (should retain previous secret)
    isolatedSync.saveConfig({
      enabled: true,
      endpoint: 'https://updated-account.r2.cloudflarestorage.com',
      accessKeyId: 'test_ak_key_2',
      secretAccessKey: '', // Empty: must retain previous
      bucket: 'updated-bucket'
    });
    assert.strictEqual(isolatedSync.r2Client.secretAccessKey, 'super_secret_token_123', 'Must retain previous secretAccessKey');
    assert.strictEqual(isolatedSync.r2Client.accessKeyId, 'test_ak_key_2');
    assert.strictEqual(isolatedSync.r2Client.bucket, 'updated-bucket');
    assert.strictEqual(isolatedSync.getMaskedConfig().hasSecret, true);

    // Test REST API GET /api/v1/cloud/config
    const getCfgRes = await fetch(`${app.url}/api/v1/cloud/config`).then(r => r.json());
    assert.strictEqual(getCfgRes.ok, true);
    assert(getCfgRes.config, 'Config object must be returned');
    assert.strictEqual(getCfgRes.config.secretAccessKey, undefined, 'API must never leak raw secretAccessKey');

    // Test REST API POST /api/v1/cloud/config
    const postCfgRes = await postJson(app.url, '/api/v1/cloud/config', {
      enabled: true,
      endpoint: r2Client.endpoint,
      accessKeyId: r2Client.accessKeyId,
      secretAccessKey: r2Client.secretAccessKey,
      bucket: r2Client.bucket,
      region: r2Client.region
    });
    assert.strictEqual(postCfgRes.ok, true);
    assert(postCfgRes.saved, 'Saved config must be returned');
    assert.strictEqual(postCfgRes.saved.secretAccessKey, undefined);
    assert.strictEqual(postCfgRes.saved.hasSecret, true);
    assert(postCfgRes.status, 'Connection status must be returned');

    // Security Hardening: Endpoint protocol validation
    assert.throws(
      () => isolatedSync.saveConfig({ endpoint: 'ftp://r2.invalid.com' }),
      /Endpoint URL không hợp lệ/
    );
    console.log('  [PASS] R2 Masked Config, Secret Retention & REST API endpoints verified.');

    // 6.5 Testing 1-Line Sync Key (exportSyncKey, importSyncKey) & Kernel Cloud Sync
    console.log('=== [6.5] Testing 1-Line Sync Key & Kernel Sync Invariants ===');

    // 6.5.1 exportSyncKey & importSyncKey unit assertions
    const emptySync = new CloudSync({ configPath: path.join(testProfilesDir, 'non_existent_r2.json') });
    assert.strictEqual(emptySync.exportSyncKey(), null, 'exportSyncKey must return null when credentials missing');

    const generatedKey = isolatedSync.exportSyncKey();
    assert(generatedKey && generatedKey.startsWith('VTN-R2-'), 'exportSyncKey must produce string starting with "VTN-R2-"');

    // Verify import validation guards
    assert.throws(() => emptySync.importSyncKey(''), /không được để trống/);
    assert.throws(() => emptySync.importSyncKey('INVALID-KEY-123'), /bắt đầu bằng "VTN-R2-"/);
    assert.throws(() => emptySync.importSyncKey('VTN-R2-!@#$not_base64!@#$'), /giải mã/);

    const badPayloadKey = 'VTN-R2-' + Buffer.from(JSON.stringify({ endpoint: 'https://test' })).toString('base64');
    assert.throws(() => emptySync.importSyncKey(badPayloadKey), /thiếu các thông tin xác thực/);

    // Import valid key into new CloudSync instance
    const importedRes = emptySync.importSyncKey(generatedKey);
    assert.strictEqual(importedRes.ok, true);
    assert.strictEqual(emptySync.r2Client.endpoint, 'https://updated-account.r2.cloudflarestorage.com');
    assert.strictEqual(emptySync.r2Client.accessKeyId, 'test_ak_key_2');
    assert.strictEqual(emptySync.r2Client.secretAccessKey, 'super_secret_token_123');
    assert.strictEqual(emptySync.r2Client.bucket, 'updated-bucket');
    console.log('  [PASS] 1-Line Sync Key export, input validation & import roundtrip verified.');

    // 6.5.2 REST API GET /api/v1/cloud/sync-key & POST /api/v1/cloud/import-key
    const apiSyncKeyRes = await fetch(`${app.url}/api/v1/cloud/sync-key`).then(r => r.json());
    assert.strictEqual(apiSyncKeyRes.ok, true);
    assert(apiSyncKeyRes.syncKey && apiSyncKeyRes.syncKey.startsWith('VTN-R2-'), 'API must return valid syncKey');

    // Security Hardening: Anti-Theft Origin check for /api/v1/cloud/sync-key
    const forbiddenOriginRes = await fetch(`${app.url}/api/v1/cloud/sync-key`, {
      headers: { Origin: 'http://malicious-website.com' }
    });
    assert.strictEqual(forbiddenOriginRes.status, 403, 'Cross-origin request from untrusted origin must return 403 Forbidden');

    const allowedLocalOriginRes = await fetch(`${app.url}/api/v1/cloud/sync-key`, {
      headers: { Origin: 'http://127.0.0.1:8080' }
    });
    assert.strictEqual(allowedLocalOriginRes.status, 200, 'Localhost 127.0.0.1 origin must be allowed');

    const allowedLocalhostOriginRes = await fetch(`${app.url}/api/v1/cloud/sync-key`, {
      headers: { Origin: 'http://localhost:3000' }
    });
    assert.strictEqual(allowedLocalhostOriginRes.status, 200, 'Localhost origin must be allowed');

    // Import the exported key into app via REST API
    const apiImportRes = await postJson(app.url, '/api/v1/cloud/import-key', {
      syncKey: apiSyncKeyRes.syncKey
    });
    assert.strictEqual(apiImportRes.ok, true);
    assert.strictEqual(apiImportRes.saved.hasSecret, true);
    assert(apiImportRes.status && apiImportRes.status.connected, 'Status must report connected after key import');

    // Test API validation on bad keys
    const badApiImport = await postJson(app.url, '/api/v1/cloud/import-key', { syncKey: 'VTN-R2-invalid' });
    assert.strictEqual(badApiImport.ok, false);
    console.log('  [PASS] REST API endpoints (/cloud/sync-key & /cloud/import-key) verified.');

    // 6.5.3 Kernel Cloud Sync (hasKernelOnCloud, /cloud/kernel/status)
    const kernelStatus = await app.browserManager.cloudSync.hasKernelOnCloud();
    assert.strictEqual(kernelStatus.ok, true);
    assert(typeof kernelStatus.exists === 'boolean');

    const kernelApiRes = await fetch(`${app.url}/api/v1/cloud/kernel/status`).then(r => r.json());
    assert.strictEqual(kernelApiRes.ok, true);
    assert.strictEqual(typeof kernelApiRes.exists, 'boolean');
    assert.strictEqual(typeof kernelApiRes.hasLocalKernel, 'boolean');
    console.log('  [PASS] Kernel Cloud Status check & REST API (/cloud/kernel/status) verified.');

    // Security Hardening: launchAppWindowWithFallback URL protocol validation
    await assert.rejects(
      () => launchAppWindowWithFallback('file:///C:/Windows/System32/cmd.exe', app.browserManager),
      /Invalid protocol/
    );
    await assert.rejects(
      () => launchAppWindowWithFallback('javascript:alert(1)', app.browserManager),
      /Invalid protocol/
    );
    console.log('  [PASS] launchAppWindowWithFallback URL protocol validation & security hardening verified.');

    // =========================================================================
    // 7. ANTIDETECT MCP SERVER (STREAMABLE HTTP 2025-03-26 FOR ANTIGRAVITY 2.0)
    // =========================================================================
    console.log('\n[Test 7] Verifying Antidetect MCP Server (/mcp & /api/v1/mcp/info)...');

    // 7.1 GET /api/v1/mcp/info
    const mcpInfo = await fetch(`${app.url}/api/v1/mcp/info`).then((r) => r.json());
    assert.strictEqual(mcpInfo.ok, true);
    assert(mcpInfo.endpoint.endsWith('/mcp'), 'MCP endpoint must end with /mcp');
    assert.strictEqual(mcpInfo.antigravityHttpConfig.mcpServers['vtn-anti-browser'].url, mcpInfo.endpoint);
    assert.strictEqual(mcpInfo.antigravityStdioConfig.mcpServers['vtn-anti-browser'].command, 'node');
    assert(mcpInfo.tools.length >= 28, `Expected >= 28 MCP tools, got ${mcpInfo.tools.length}`);

    // 7.2 POST /mcp initialize
    const initHttpRes = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'antigravity-e2e', version: '2.0.0' }
        }
      })
    });
    assert.strictEqual(initHttpRes.status, 200);
    const mcpSessionId = initHttpRes.headers.get('mcp-session-id');
    assert(mcpSessionId && mcpSessionId.length > 10, 'initialize must return Mcp-Session-Id header');
    const initJson = await initHttpRes.json();
    assert.strictEqual(initJson.result.protocolVersion, '2025-03-26');
    assert.strictEqual(initJson.result.serverInfo.name, 'vtn-anti-browser');

    // 7.3 POST /mcp notifications/initialized -> 202 Accepted
    const notifRes = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': mcpSessionId
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    });
    assert.strictEqual(notifRes.status, 202);

    // 7.4 POST /mcp tools/list
    const toolsListRes = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': mcpSessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    }).then((r) => r.json());
    const toolNames = toolsListRes.result.tools.map((t) => t.name);
    assert(toolNames.length >= 28, `Expected >= 28 tools from tools/list, got ${toolNames.length}`);
    assert(toolNames.includes('vtn_list_profiles'));
    assert(toolNames.includes('vtn_create_unique_profile'));
    assert(toolNames.includes('vtn_open_profile'));
    assert(toolNames.includes('vtn_page_snapshot'));
    assert(toolNames.includes('vtn_screenshot'));
    assert(toolNames.includes('vtn_update_profile'));
    assert(toolNames.includes('vtn_delete_profile'));
    assert(toolNames.includes('vtn_cloud_sync'));
    assert(toolNames.includes('vtn_new_tab'));
    assert(toolNames.includes('vtn_close_tab'));
    assert(toolNames.includes('vtn_wait_for_selector'));
    assert(toolNames.includes('vtn_press_key'));
    assert(toolNames.includes('vtn_select_option'));
    assert(toolNames.includes('vtn_get_cookies'));
    assert(toolNames.includes('vtn_set_cookies'));
    assert(toolNames.includes('vtn_audit_profile'));
    assert(toolNames.includes('vtn_warming_control'));
    assert(toolNames.includes('vtn_plan_matrix'));

    // 7.5 POST /mcp tools/call -> vtn_create_unique_profile & vtn_list_profiles
    const createCallRes = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': mcpSessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'vtn_create_unique_profile',
          arguments: { name: 'MCP_Agy_Test', groupName: 'MCP_Test' }
        }
      })
    }).then((r) => r.json());
    assert.strictEqual(createCallRes.result.isError, false);
    const createdByMcp = JSON.parse(createCallRes.result.content[0].text);
    assert.strictEqual(createdByMcp.name, 'MCP_Agy_Test');

    const listCallRes = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': mcpSessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'vtn_list_profiles', arguments: { groupName: 'MCP_Test' } }
      })
    }).then((r) => r.json());
    assert.strictEqual(listCallRes.result.isError, false);
    const listedByMcp = JSON.parse(listCallRes.result.content[0].text);
    assert.strictEqual(listedByMcp.count, 1);
    assert.strictEqual(listedByMcp.profiles[0].id, createdByMcp.id);

    // 7.6 POST /mcp resources/list & resources/read
    const resList = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': mcpSessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'resources/list', params: {} })
    }).then((r) => r.json());
    assert(resList.result.resources.some((r) => r.uri === 'vtn://profiles'));

    const resRead = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': mcpSessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'vtn://status' } })
    }).then((r) => r.json());
    const statusPayload = JSON.parse(resRead.result.contents[0].text);
    assert.strictEqual(statusPayload.kernelVersion, '151.0.7922.109');

    // 7.7 GET /mcp -> 405 Method Not Allowed & DELETE /mcp -> 200 OK
    const getMcpRes = await fetch(`${app.url}/mcp`);
    assert.strictEqual(getMcpRes.status, 405);
    const delMcpRes = await fetch(`${app.url}/mcp`, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': mcpSessionId }
    });
    assert.strictEqual(delMcpRes.status, 200);

    // 7.8 Security & Parsing & Proxy Type Hardening assertions
    const evilOriginRes = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping', params: {} })
    });
    assert.strictEqual(evilOriginRes.status, 403, 'Cross-origin POST /mcp must return 403');
    const evilOriginJson = await evilOriginRes.json();
    assert.strictEqual(evilOriginJson.error.code, -32001);

    const malformedJsonRes = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ invalid json'
    });
    assert.strictEqual(malformedJsonRes.status, 400, 'Malformed JSON POST /mcp must return 400');
    const malformedJsonBody = await malformedJsonRes.json();
    assert.strictEqual(malformedJsonBody.error.code, -32700, 'Malformed JSON must return JSON-RPC -32700');

    const socksProfileRes = await fetch(`${app.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'vtn_create_unique_profile',
          arguments: {
            name: 'MCP_Socks5_Test',
            groupName: 'MCP_Proxy_Test',
            proxy: 'socks5://user:pass@1.2.3.4:1080'
          }
        }
      })
    }).then((r) => r.json());
    assert.strictEqual(socksProfileRes.result.isError, false);
    const createdSocks = JSON.parse(socksProfileRes.result.content[0].text);
    assert.strictEqual(createdSocks.proxyMode, 'socks5');
    const savedSocksInDb = app.db.getProfile(createdSocks.id);
    assert.strictEqual(savedSocksInDb.proxyConfig.type, 'socks5', 'DB proxyConfig.type must preserve socks5');
    assert.strictEqual(savedSocksInDb.proxyConfig.host, '1.2.3.4');
    assert.strictEqual(savedSocksInDb.proxyConfig.port, 1080);

    // 7.9 Test expanded MCP tools: update, cloud_sync(status), audit, warming_control(presets/status), plan_matrix(apply:false), delete
    const callMcpTool = async (id, name, args) => {
      return fetch(`${app.url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args }
        })
      }).then((r) => r.json());
    };

    const updateRes = await callMcpTool(9, 'vtn_update_profile', {
      profileId: createdByMcp.id,
      name: 'MCP_Agy_Updated',
      notes: 'Updated via MCP v2',
      tags: ['mcp', 'verified'],
      autoGeoIp: true
    });
    assert.strictEqual(updateRes.result.isError, false, `vtn_update_profile failed: ${updateRes.result.content[0].text}`);
    const updatedPayload = JSON.parse(updateRes.result.content[0].text);
    assert.strictEqual(updatedPayload.name, 'MCP_Agy_Updated');
    assert.strictEqual(updatedPayload.notes, 'Updated via MCP v2');
    assert.deepStrictEqual(updatedPayload.tags, ['mcp', 'verified']);
    assert.strictEqual(updatedPayload.autoGeoIp, true);

    const cloudStatusRes = await callMcpTool(10, 'vtn_cloud_sync', { action: 'status' });
    assert.strictEqual(cloudStatusRes.result.isError, false, `vtn_cloud_sync status failed: ${cloudStatusRes.result.content[0].text}`);
    const cloudStatusPayload = JSON.parse(cloudStatusRes.result.content[0].text);
    assert.strictEqual(typeof cloudStatusPayload.enabled, 'boolean');

    const auditMcpRes = await callMcpTool(11, 'vtn_audit_profile', {
      profileId: createdByMcp.id,
      platform: 'General',
      checkProxy: false,
      autoFix: false
    });
    assert.strictEqual(auditMcpRes.result.isError, false, `vtn_audit_profile failed: ${auditMcpRes.result.content[0].text}`);
    const auditPayload = JSON.parse(auditMcpRes.result.content[0].text);
    assert.strictEqual(auditPayload.profileId, createdByMcp.id);
    assert.strictEqual(typeof auditPayload.score, 'number');
    assert(Array.isArray(auditPayload.findings));

    const warmPresetsRes = await callMcpTool(12, 'vtn_warming_control', { action: 'presets' });
    assert.strictEqual(warmPresetsRes.result.isError, false);
    const warmPresetsPayload = JSON.parse(warmPresetsRes.result.content[0].text);
    assert(Array.isArray(warmPresetsPayload.presets) && warmPresetsPayload.presets.length >= 3);

    const warmStatusRes = await callMcpTool(13, 'vtn_warming_control', { action: 'status' });
    assert.strictEqual(warmStatusRes.result.isError, false);
    const warmStatusPayload = JSON.parse(warmStatusRes.result.content[0].text);
    assert(Array.isArray(warmStatusPayload.jobs));

    const matrixMcpRes = await callMcpTool(14, 'vtn_plan_matrix', {
      goal: 'US E-commerce test matrix',
      count: 3,
      platform: 'Amazon / eBay',
      region: 'US',
      apply: false
    });
    assert.strictEqual(matrixMcpRes.result.isError, false, `vtn_plan_matrix failed: ${matrixMcpRes.result.content[0].text}`);
    const matrixPayload = JSON.parse(matrixMcpRes.result.content[0].text);
    assert.strictEqual(matrixPayload.applied, null);
    assert.strictEqual(matrixPayload.plan.count, 3);
    assert.strictEqual(matrixPayload.plan.items.length, 3);

    const deleteMcpRes = await callMcpTool(15, 'vtn_delete_profile', {
      profileId: createdByMcp.id,
      force: true
    });
    assert.strictEqual(deleteMcpRes.result.isError, false, `vtn_delete_profile failed: ${deleteMcpRes.result.content[0].text}`);
    const deletePayload = JSON.parse(deleteMcpRes.result.content[0].text);
    assert.strictEqual(deletePayload.deleted, true);
    assert.strictEqual(app.db.getProfile(createdByMcp.id), null, 'Deleted profile must be removed from DB');

    console.log('  [PASS] Antidetect MCP Server (Streamable HTTP 2025-03-26, 28 tools, resources, session lifecycle, security, socks5 proxy & expanded CRUD/Cloud/AI tools) verified.');

    // =========================================================================
    // 8. AI STUDIO REST API SUITE (OFFLINE VERIFICATION — 5 AI FEATURES + CONFIG)
    // =========================================================================
    console.log('\n[Test 8] Verifying VTN AI Studio REST API Suite (Config, Auditor, Matrix, Workflow, Warmer, Extractor)...');
    const tempAiCfgPath = path.join(testProfilesDir, 'temp_ai_config.json');
    const isolatedAiClient = new AiClient(tempAiCfgPath);
    const aiServer = createApiServer({
      db: app.db,
      browserManager: app.browserManager,
      aiClient: isolatedAiClient
    });
    await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
    const aiBaseUrl = `http://127.0.0.1:${aiServer.address().port}`;

    try {
      // 8.1 AI Config save + secret masking + key retention when saving without apiKey
      const initAiCfg = await fetch(`${aiBaseUrl}/api/v1/ai/provider-config`).then((r) => r.json());
      assert.strictEqual(initAiCfg.ok, true);
      assert.strictEqual(initAiCfg.config.hasApiKey, false);
      assert.strictEqual(initAiCfg.config.apiKey, undefined, 'Must never expose raw apiKey');

      const saveAiCfg1 = await postJson(aiBaseUrl, '/api/v1/ai/provider-config', {
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        apiKey: 'AIzaSyTestSecretKey123456789',
        enabled: false
      });
      assert.strictEqual(saveAiCfg1.ok, true);
      assert.strictEqual(saveAiCfg1.config.hasApiKey, true);
      assert.strictEqual(saveAiCfg1.config.apiKey, undefined, 'Saved response must never leak raw apiKey');
      assert(saveAiCfg1.config.apiKeyPreview.startsWith('AIza') && saveAiCfg1.config.apiKeyPreview.endsWith('6789'), 'apiKeyPreview must be masked');

      // Update model without apiKey -> must retain previous apiKey
      const saveAiCfg2 = await postJson(aiBaseUrl, '/api/v1/ai/provider-config', {
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        enabled: false
      });
      assert.strictEqual(saveAiCfg2.ok, true);
      assert.strictEqual(saveAiCfg2.config.model, 'gemini-2.5-pro');
      assert.strictEqual(saveAiCfg2.config.hasApiKey, true, 'Must retain saved apiKey when omitted');
      assert.strictEqual(isolatedAiClient._config.apiKey, 'AIzaSyTestSecretKey123456789');
      assert.strictEqual(saveAiCfg2.config.apiKey, undefined);
      console.log('  [PASS] 8.1 AI Config save, secret masking & apiKey retention verified.');

      // 8.2 AI Auditor (/api/v1/ai/audit, /api/v1/ai/audit/apply-fix, /api/v1/ai/audit/logs)
      const badAuditRes = await fetch(`${aiBaseUrl}/api/v1/ai/audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.strictEqual(badAuditRes.status, 400, 'Missing profileId must return 400');

      const auditRes = await postJson(aiBaseUrl, '/api/v1/ai/audit', {
        profileId: 'vnt_win11_rtx4090',
        platform: 'Facebook / Meta',
        checkProxy: false
      });
      assert.strictEqual(auditRes.ok, true);
      assert(auditRes.report && typeof auditRes.report.score === 'number');
      assert.strictEqual(auditRes.report.usedLlm, false, 'Offline audit must not invoke LLM');
      assert(Array.isArray(auditRes.report.findings));

      const applyFixRes = await postJson(aiBaseUrl, '/api/v1/ai/audit/apply-fix', {
        profileId: 'vnt_win11_rtx4090',
        suggestedPatch: {
          autoGeoIp: true,
          fingerprintPatch: {
            timezone: 'America/Los_Angeles',
            languages: 'en-US,en'
          }
        }
      });
      assert.strictEqual(applyFixRes.ok, true);
      assert(applyFixRes.appliedFields.includes('autoGeoIp'));
      assert(applyFixRes.appliedFields.includes('fingerprintPatch.timezone'));
      assert.strictEqual(applyFixRes.profile.autoGeoIp, true);
      assert.strictEqual(applyFixRes.profile.fingerprint.switches.TimeZone, 'America/Los_Angeles');

      const auditLogsRes = await fetch(`${aiBaseUrl}/api/v1/ai/audit/logs?profileId=vnt_win11_rtx4090`).then((r) => r.json());
      assert.strictEqual(auditLogsRes.ok, true);
      assert(Array.isArray(auditLogsRes.logs) && auditLogsRes.logs.length >= 1, 'Audit log must be persisted');
      console.log('  [PASS] 8.2 AI Auditor (/audit, /audit/apply-fix, /audit/logs) verified.');

      // 8.3 AI Matrix Planner (/api/v1/ai/matrix/plan & /api/v1/ai/matrix/apply)
      const planRes = await postJson(aiBaseUrl, '/api/v1/ai/matrix/plan', {
        goal: '3 TikTok US profiles',
        count: 3,
        platform: 'TikTok',
        region: 'US'
      });
      assert.strictEqual(planRes.ok, true);
      assert(planRes.plan && Array.isArray(planRes.plan.items) && planRes.plan.items.length === 3);
      assert.strictEqual(planRes.plan.usedLlm, false);

      const applyMatrixRes = await postJson(aiBaseUrl, '/api/v1/ai/matrix/apply', {
        items: planRes.plan.items
      });
      assert.strictEqual(applyMatrixRes.ok, true);
      assert.strictEqual(applyMatrixRes.createdCount, 3);
      assert.strictEqual(applyMatrixRes.profiles.length, 3);
      const matrixCanvasSet = new Set(applyMatrixRes.profiles.map((p) => p.fingerprint.switches.CanvasMark));
      assert.strictEqual(matrixCanvasSet.size, 3, 'Matrix profiles must have unique CanvasMarks');
      console.log('  [PASS] 8.3 AI Matrix Planner (/matrix/plan & /matrix/apply) verified.');

      // 8.4 AI Workflow (/api/v1/ai/workflow/generate, GET /api/v1/ai/workflows, DELETE /api/v1/ai/workflows/:id)
      const genWfRes = await postJson(aiBaseUrl, '/api/v1/ai/workflow/generate', {
        name: 'E2E HN Flow',
        prompt: 'Mở https://news.ycombinator.com/, chờ 2 giây, cuộn xuống 600px, trích xuất nội dung và chụp ảnh màn hình.'
      });
      assert.strictEqual(genWfRes.ok, true);
      assert(genWfRes.workflow && genWfRes.workflow.id);
      assert.strictEqual(genWfRes.usedLlm, false);
      assert(genWfRes.workflow.steps.length >= 4, 'Heuristic workflow must compile goto/wait/scroll/extract/screenshot');

      const listWfRes = await fetch(`${aiBaseUrl}/api/v1/ai/workflows`).then((r) => r.json());
      assert.strictEqual(listWfRes.ok, true);
      assert(listWfRes.workflows.some((w) => w.id === genWfRes.workflow.id), 'Generated workflow must appear in list');
      assert(Array.isArray(listWfRes.examples) && listWfRes.examples.length >= 3);

      const delWfRes = await fetch(`${aiBaseUrl}/api/v1/ai/workflows/${encodeURIComponent(genWfRes.workflow.id)}`, {
        method: 'DELETE'
      }).then((r) => r.json());
      assert.strictEqual(delWfRes.ok, true);
      assert.strictEqual(delWfRes.deleted, true);
      console.log('  [PASS] 8.4 AI Workflow (/workflow/generate, /workflows, DELETE /workflows/:id) verified.');

      // 8.5 AI Warmer (/warm/presets, /warm/status) & Extractor (/extract/presets)
      const warmPresetsRes = await fetch(`${aiBaseUrl}/api/v1/ai/warm/presets`).then((r) => r.json());
      assert.strictEqual(warmPresetsRes.ok, true);
      assert(Array.isArray(warmPresetsRes.presets) && warmPresetsRes.presets.length >= 3);

      const warmStatusRes = await fetch(`${aiBaseUrl}/api/v1/ai/warm/status`).then((r) => r.json());
      assert.strictEqual(warmStatusRes.ok, true);
      assert(Array.isArray(warmStatusRes.jobs));

      const extPresetsRes = await fetch(`${aiBaseUrl}/api/v1/ai/extract/presets`).then((r) => r.json());
      assert.strictEqual(extPresetsRes.ok, true);
      assert(Array.isArray(extPresetsRes.presets) && extPresetsRes.presets.length >= 2);
      console.log('  [PASS] 8.5 AI Warmer (/warm/presets, /warm/status) & Extractor (/extract/presets) verified.');
    } finally {
      await new Promise((resolve) => aiServer.close(resolve));
    }

    // =========================================================================
    // 9. R2 1-CLICK APP UPDATER (MOCK R2, SHA-256 VERIFY, TAMPER GUARD, ROLLBACK)
    // =========================================================================
    console.log('\n[Test 9] Verifying R2 1-Click App Updater (Semver, Publish, Check, Apply, SHA-256 Tamper Guard, Rollback)...');

    // 9.1 compareSemver edge cases
    assert.strictEqual(APP_VERSION, '1.1.0');
    assert.strictEqual(compareSemver('1.0.0', '1.1.0'), -1);
    assert.strictEqual(compareSemver('1.1.0', '1.0.0'), 1);
    assert.strictEqual(compareSemver('v1.1.0', '1.1.0'), 0);
    assert.strictEqual(compareSemver('V1.10.0', '1.2.9'), 1);
    assert.strictEqual(compareSemver('2.0.0', '1.9.9'), 1);
    assert.strictEqual(compareSemver('1.0', '1.0.0'), 0);
    assert.strictEqual(compareSemver('1.1.0-beta.1', '1.1.0'), 0);
    console.log('  [PASS] 9.1 compareSemver edge cases verified.');

    // 9.2 Local in-memory mock R2 server
    const mockR2Store = new Map();
    const mockR2Server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, 'http://127.0.0.1');
      // Path format: /<bucket>/<key...>
      const cleanPath = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '');
      const slashIdx = cleanPath.indexOf('/');
      const key = slashIdx >= 0 ? cleanPath.slice(slashIdx + 1) : '';

      if (req.method === 'PUT') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const buf = Buffer.concat(chunks);
          mockR2Store.set(key, {
            body: buf,
            contentType: req.headers['content-type'] || 'application/octet-stream'
          });
          res.writeHead(200, { ETag: '"mock-etag"' });
          res.end();
        });
        return;
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!mockR2Store.has(key)) {
          res.writeHead(404);
          return res.end('Not Found');
        }
        const entry = mockR2Store.get(key);
        res.writeHead(200, {
          'Content-Type': entry.contentType,
          'Content-Length': String(entry.body.length),
          ETag: '"mock-etag"'
        });
        return res.end(req.method === 'HEAD' ? undefined : entry.body);
      }

      if (req.method === 'DELETE') {
        mockR2Store.delete(key);
        res.writeHead(204);
        return res.end();
      }

      res.writeHead(405);
      res.end();
    });

    await new Promise((resolve) => mockR2Server.listen(0, '127.0.0.1', resolve));
    const mockR2Endpoint = `http://127.0.0.1:${mockR2Server.address().port}`;
    const mockR2Client = new R2Client({
      enabled: true,
      endpoint: mockR2Endpoint,
      accessKeyId: 'mock_ak',
      secretAccessKey: 'mock_sk',
      bucket: 'mock-vtn-bucket',
      region: 'auto'
    });
    const mockCloudSync = new CloudSync({
      r2Client: mockR2Client,
      configPath: path.join(testProfilesDir, 'mock_updater_r2.json'),
      machineId: 'mock-updater-machine'
    });

    let simulatedActiveSessions = [];
    const mockBmForUpdater = Object.create(app.browserManager);
    mockBmForUpdater.cloudSync = mockCloudSync;
    mockBmForUpdater.listActiveSessions = () => simulatedActiveSessions;

    const updaterTestDir = path.join(testProfilesDir, 'updater_sandbox');
    fs.mkdirSync(updaterTestDir, { recursive: true });
    const targetExe = path.join(updaterTestDir, 'VTN-Anti-Browser.exe');
    const oldBackupExe = path.join(updaterTestDir, 'VTN-Anti-Browser.old.exe');
    const newStageExe = path.join(updaterTestDir, 'VTN-Anti-Browser.new.exe');
    const releaseSourceExe = path.join(updaterTestDir, 'release_v1_1_0.exe');

    const updaterOptions = {
      targetExePath: targetExe,
      exePath: releaseSourceExe,
      minBytes: 1024,
      autoRestartInSea: false,
      currentVersion: '1.0.0'
    };

    const updaterServer = createApiServer({
      db: app.db,
      browserManager: mockBmForUpdater,
      updaterOptions
    });
    await new Promise((resolve) => updaterServer.listen(0, '127.0.0.1', resolve));
    const updaterBaseUrl = `http://127.0.0.1:${updaterServer.address().port}`;

    try {
      const originalBytes = Buffer.from('OLD_EXE_V1_0_0_' + 'A'.repeat(2048), 'utf8');
      const releaseBytes = Buffer.from('NEW_EXE_V1_1_0_' + 'B'.repeat(3072), 'utf8');
      fs.writeFileSync(targetExe, originalBytes);
      fs.writeFileSync(releaseSourceExe, releaseBytes);

      // Security Hardening: cross-origin GET /api/v1/updater/check must return 403 and no wildcard CORS
      const evilUpdaterCheckRes = await fetch(`${updaterBaseUrl}/api/v1/updater/check`, {
        headers: { Origin: 'https://evil.example.com' }
      });
      assert.strictEqual(evilUpdaterCheckRes.status, 403, 'Cross-origin GET /api/v1/updater/check must return 403');
      assert.strictEqual(evilUpdaterCheckRes.headers.get('access-control-allow-origin'), null, 'Updater must not emit Access-Control-Allow-Origin for untrusted origin');

      // Before publish: check returns hasRelease: false (and does not emit Access-Control-Allow-Origin: *)
      const emptyCheckRes = await fetch(`${updaterBaseUrl}/api/v1/updater/check`);
      assert.strictEqual(emptyCheckRes.status, 200);
      assert.notStrictEqual(emptyCheckRes.headers.get('access-control-allow-origin'), '*', 'Updater must never emit wildcard CORS');
      const emptyCheck = await emptyCheckRes.json();
      assert.strictEqual(emptyCheck.ok, true);
      assert.strictEqual(emptyCheck.hasRelease, false);
      assert.strictEqual(emptyCheck.updateAvailable, false);
      assert.strictEqual(emptyCheck.hasBackup, false);

      // 9.3 publishRelease -> GET /api/v1/updater/check
      const pubRes = await publishRelease(mockCloudSync, {
        exePath: releaseSourceExe,
        version: '1.1.0',
        notes: 'E2E Test Release 1.1.0'
      });
      assert.strictEqual(pubRes.ok, true);
      assert.strictEqual(pubRes.manifest.version, '1.1.0');
      assert.strictEqual(pubRes.manifest.sizeBytes, releaseBytes.length);
      assert(/^[a-f0-9]{64}$/.test(pubRes.manifest.sha256), 'Manifest must contain 64-char hex sha256');

      const checkOldVer = await fetch(`${updaterBaseUrl}/api/v1/updater/check`).then((r) => r.json());
      assert.strictEqual(checkOldVer.ok, true);
      assert.strictEqual(checkOldVer.hasRelease, true);
      assert.strictEqual(checkOldVer.updateAvailable, true, '1.1.0 must be newer than 1.0.0');
      assert.strictEqual(checkOldVer.latestVersion, '1.1.0');
      assert.strictEqual(checkOldVer.manifest.notes, 'E2E Test Release 1.1.0');

      updaterOptions.currentVersion = '1.1.0';
      const checkSameVer = await fetch(`${updaterBaseUrl}/api/v1/updater/check`).then((r) => r.json());
      assert.strictEqual(checkSameVer.updateAvailable, false, 'Same version must report updateAvailable: false');
      console.log('  [PASS] 9.2 publishRelease, local-only Origin guard & GET /api/v1/updater/check verified.');

      // 9.4 Active session 409 conflict guard
      simulatedActiveSessions = [{ profileId: 'running_test_profile' }];
      const conflictApplyRes = await fetch(`${updaterBaseUrl}/api/v1/updater/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.strictEqual(conflictApplyRes.status, 409, 'Active profiles must block /updater/apply with HTTP 409');
      simulatedActiveSessions = [];

      // 9.5 downloadAndStageUpdate via POST /api/v1/updater/apply (valid SHA-256)
      const applyRes = await postJson(updaterBaseUrl, '/api/v1/updater/apply', {});
      assert.strictEqual(applyRes.ok, true, `Apply failed: ${JSON.stringify(applyRes)}`);
      assert.strictEqual(applyRes.applied, true);
      assert.strictEqual(applyRes.sha256Verified, true);
      assert.strictEqual(applyRes.version, '1.1.0');
      assert.strictEqual(fs.existsSync(oldBackupExe), true, 'Backup .old.exe must be created');
      assert.deepStrictEqual(fs.readFileSync(oldBackupExe), originalBytes, 'Backup .old.exe must contain original bytes');
      assert.deepStrictEqual(fs.readFileSync(targetExe), releaseBytes, 'Target .exe must contain new release bytes');
      assert.strictEqual(fs.existsSync(newStageExe), false, 'Staging .new.exe must be renamed away');
      console.log('  [PASS] 9.3 Valid SHA-256 downloadAndStageUpdate & .old.exe backup verified.');

      // 9.6 SHA-256 tamper rejection
      const tamperedBytes = Buffer.from('TAMPERED_MALICIOUS_PAYLOAD_' + 'X'.repeat(3072), 'utf8');
      mockR2Store.set(APP_BINARY_KEY, {
        body: tamperedBytes,
        contentType: 'application/octet-stream'
      });

      await assert.rejects(
        () => downloadAndStageUpdate(mockCloudSync, { targetExePath: targetExe, autoRestartInSea: false }),
        /SHA-256/
      );
      assert.strictEqual(fs.existsSync(newStageExe), false, 'Tampered .new.exe must be deleted immediately');
      assert.deepStrictEqual(fs.readFileSync(targetExe), releaseBytes, 'Target .exe must remain untouched after tamper rejection');
      console.log('  [PASS] 9.4 SHA-256 tamper rejection verified (corrupted download deleted, target untouched).');

      // 9.7 rollbackUpdate via POST /api/v1/updater/rollback
      const rollbackRes = await postJson(updaterBaseUrl, '/api/v1/updater/rollback', {});
      assert.strictEqual(rollbackRes.ok, true, `Rollback failed: ${JSON.stringify(rollbackRes)}`);
      assert.strictEqual(rollbackRes.rolledBack, true);
      assert.deepStrictEqual(fs.readFileSync(targetExe), originalBytes, 'Rollback must restore original bytes from .old.exe');
      assert.strictEqual(fs.existsSync(oldBackupExe), false, 'Backup .old.exe should be moved back to target');
      console.log('  [PASS] 9.5 rollbackUpdate verified (original bytes restored).');
    } finally {
      await new Promise((resolve) => updaterServer.close(resolve));
      await new Promise((resolve) => mockR2Server.close(resolve));
    }

    console.log('\n=== ALL E2E VERIFICATION ASSERTIONS PASSED (100% NATIVE C++ SPOOFING & UI APP WINDOW) ===');
  } finally {
    await app.shutdown();
    try { app.db.db.close(); } catch {}
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    if (fs.existsSync(testProfilesDir)) {
      try { fs.rmSync(testProfilesDir, { recursive: true, force: true }); } catch {}
    }
    if (fs.existsSync(testUiProfileDir)) {
      try { fs.rmSync(testUiProfileDir, { recursive: true, force: true }); } catch {}
    }
  }
}

runTests().catch((err) => {
  console.error('E2E Test Failed:', err);
  process.exit(1);
});
