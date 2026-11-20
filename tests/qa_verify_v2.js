/**
 * Independent QA Verification Script for VTN Anti-Browser v2 Lifecycle & Window Fixes
 * 
 * Verifies:
 * 1. shutdown() with an open HTTP Keep-Alive connection completes promptly (< 1500ms).
 * 2. appWindow exit with 0 active profiles triggers shutdown().
 * 3. appWindow exit with 1 active profile + confirmCloseProfiles: () => false keeps server alive
 *    until activeSessions empties and profile:state fires, then triggers shutdown().
 * 4. appWindow exit with 1 active profile + confirmCloseProfiles: () => true triggers shutdown() immediately.
 */

const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');
const { startVntBrowser } = require('../src/main');

function createMockProcess() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.killed = false;
  proc.kill = () => {
    proc.killed = true;
    proc.exitCode = 0;
    proc.emit('exit', 0);
  };
  return proc;
}

async function test1_KeepAlivePromptShutdown() {
  console.log('[QA-TEST-1] shutdown() with open HTTP Keep-Alive connection completes promptly');
  const app = await startVntBrowser({
    port: 0,
    openAppWindow: false,
    dbPath: ':memory:',
    exitProcess: false
  });

  const agent = new http.Agent({ keepAlive: true, maxSockets: 5 });

  // Make Keep-Alive HTTP request and hold socket open
  await new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1',
      port: app.port,
      path: '/api/v1/status',
      agent
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });

  const t0 = Date.now();
  await app.shutdown();
  const elapsed = Date.now() - t0;

  console.log(`  -> Elapsed: ${elapsed}ms (threshold: 1500ms, safety timeout: 3000ms)`);
  assert(elapsed < 1500, `Expected prompt shutdown (< 1500ms), but took ${elapsed}ms`);
  assert.strictEqual(app.server.listening, false, 'HTTP Server must not be listening after shutdown');
  agent.destroy();
  console.log('  [PASS] test1_KeepAlivePromptShutdown');
}

async function test2_AppWindowExitZeroProfiles() {
  console.log('[QA-TEST-2] appWindow exit with 0 active profiles triggers shutdown()');
  const app = await startVntBrowser({
    port: 0,
    openAppWindow: true,
    exitProcess: false,
    dbPath: ':memory:'
  });

  assert(app.appWindow && app.appWindow.process, 'AppWindow process must be created');
  assert.strictEqual(app.browserManager.activeSessions.size, 0, 'Active sessions count must be 0');

  const serverClosePromise = new Promise((resolve) => {
    if (!app.server.listening) return resolve();
    app.server.on('close', resolve);
  });

  // Terminate app window process
  app.appWindow.process.kill();

  await Promise.race([
    serverClosePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for server close on appWindow exit')), 4000))
  ]);

  assert.strictEqual(app.server.listening, false, 'Server must be shut down following appWindow close with 0 active profiles');
  console.log('  [PASS] test2_AppWindowExitZeroProfiles');
}

async function test3_AppWindowExitConfirmFalseKeepsAliveUntilEmpty() {
  console.log('[QA-TEST-3] appWindow exit with 1 profile + confirm:false keeps server alive until activeSessions empty');
  let confirmPromptCount = 0;
  const app = await startVntBrowser({
    port: 0,
    openAppWindow: true,
    exitProcess: false,
    dbPath: ':memory:',
    confirmCloseProfiles: async (count) => {
      confirmPromptCount = count;
      return false; // User selects NO: keep active profiles running in background
    }
  });

  const mockProc = createMockProcess();
  const mockSession = {
    chromeProcess: mockProc,
    closing: false
  };
  app.browserManager.activeSessions.set('qa_prof_bg', mockSession);
  assert.strictEqual(app.browserManager.activeSessions.size, 1);

  let prematureServerClose = false;
  app.server.on('close', () => { prematureServerClose = true; });

  // Kill app window process
  app.appWindow.process.kill();

  // Wait 1000ms to verify manager exit listener handled dialog and decided to stay alive
  await new Promise((r) => setTimeout(r, 1000));

  assert.strictEqual(confirmPromptCount, 1, 'confirmCloseProfiles must have received activeCount=1');
  assert.strictEqual(prematureServerClose, false, 'Server must NOT close while active profile is still running');
  assert.strictEqual(app.server.listening, true, 'Server must remain listening for API/CDP interactions');
  assert.strictEqual(mockProc.killed, false, 'Active profile process must NOT be killed');
  console.log('  -> Server and profile maintained alive after appWindow close (confirm=false)');

  // Now simulate profile closing normally
  const serverClosePromise = new Promise((resolve) => {
    if (!app.server.listening) return resolve();
    app.server.on('close', resolve);
  });

  app.browserManager.activeSessions.delete('qa_prof_bg');
  app.browserManager.emit('profile:state', { profileId: 'qa_prof_bg', state: 'stopped' });

  await Promise.race([
    serverClosePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for server shutdown after profiles drained')), 4000))
  ]);

  assert.strictEqual(app.server.listening, false, 'Server must shutdown when activeSessions reaches 0');
  console.log('  [PASS] test3_AppWindowExitConfirmFalseKeepsAliveUntilEmpty');
}

async function test4_AppWindowExitConfirmTrueShutsDownImmediately() {
  console.log('[QA-TEST-4] appWindow exit with 1 profile + confirm:true triggers immediate shutdown()');
  let confirmPromptCount = 0;
  const app = await startVntBrowser({
    port: 0,
    openAppWindow: true,
    exitProcess: false,
    dbPath: ':memory:',
    confirmCloseProfiles: async (count) => {
      confirmPromptCount = count;
      return true; // User selects YES: shut down all profiles and exit
    }
  });

  const mockProc = createMockProcess();
  const mockSession = {
    chromeProcess: mockProc,
    closing: false
  };
  app.browserManager.activeSessions.set('qa_prof_term', mockSession);
  assert.strictEqual(app.browserManager.activeSessions.size, 1);

  const serverClosePromise = new Promise((resolve) => {
    if (!app.server.listening) return resolve();
    app.server.on('close', resolve);
  });

  // Kill app window process
  app.appWindow.process.kill();

  await Promise.race([
    serverClosePromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for immediate server shutdown')), 4000))
  ]);

  assert.strictEqual(confirmPromptCount, 1, 'confirmCloseProfiles must have received activeCount=1');
  assert.strictEqual(app.server.listening, false, 'Server must shut down immediately');
  assert.strictEqual(mockProc.killed, true, 'Active profile chromeProcess must have been killed by closeAll()');
  console.log('  [PASS] test4_AppWindowExitConfirmTrueShutsDownImmediately');
}

async function runAll() {
  console.log('=== STARTING INDEPENDENT QA LIFECYCLE & WINDOW VERIFICATION ===\n');
  const tStart = Date.now();
  await test1_KeepAlivePromptShutdown();
  await test2_AppWindowExitZeroProfiles();
  await test3_AppWindowExitConfirmFalseKeepsAliveUntilEmpty();
  await test4_AppWindowExitConfirmTrueShutsDownImmediately();
  const totalElapsed = Date.now() - tStart;
  console.log(`\n=== ALL 4 QA LIFECYCLE TESTS PASSED (${totalElapsed}ms) ===`);
}

runAll()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n[QA FAIL] Exception during verification:', err);
    process.exit(1);
  });
