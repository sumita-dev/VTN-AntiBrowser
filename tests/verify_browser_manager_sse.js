const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');
const { BrowserManager } = require('../src/core/browser-manager');
const { createApiServer } = require('../src/api/server');

async function main() {
  console.log('=== STARTING BROWSER MANAGER & SSE VERIFICATION ===\n');

  // 1. Verify BrowserManager EventEmitter inheritance and mechanics
  console.log('[Step 1] Verifying BrowserManager EventEmitter...');
  const bm = new BrowserManager();
  assert(bm instanceof EventEmitter, 'BrowserManager must be an instance of EventEmitter');
  assert.strictEqual(typeof bm.emit, 'function', 'BrowserManager must have emit()');
  assert.strictEqual(typeof bm.on, 'function', 'BrowserManager must have on()');
  assert.strictEqual(typeof bm.off, 'function', 'BrowserManager must have off()');

  let emittedEvents = [];
  const testListener = (payload) => {
    emittedEvents.push(payload);
  };
  bm.on('profile:state', testListener);

  const mockSession = {
    chromeProcess: { pid: 99999, exitCode: null },
    debuggingPort: 54321,
    browserWsEndpoint: 'ws://127.0.0.1:54321/devtools/browser/abc-123',
    pageWsEndpoint: 'ws://127.0.0.1:54321/devtools/page/def-456',
    proxyTunnel: { localPort: 8080 },
    startedAt: '2026-11-13T12:00:00.000Z',
    geoInfo: { ip: '1.2.3.4', country: 'US' },
    closing: false
  };

  bm._emitProfileState('profile_test_1', 'running', mockSession);
  assert.strictEqual(emittedEvents.length, 1, 'Expected 1 emitted event');
  const ev1 = emittedEvents[0];
  assert.strictEqual(ev1.profileId, 'profile_test_1');
  assert.strictEqual(ev1.state, 'running');
  assert.strictEqual(ev1.activeSession.pid, 99999);
  assert.strictEqual(ev1.activeSession.debuggingPort, 54321);
  assert.strictEqual(ev1.activeSession.browserWsEndpoint, 'ws://127.0.0.1:54321/devtools/browser/abc-123');
  assert.strictEqual(ev1.activeSession.closing, false);
  assert(typeof ev1.timestamp === 'number');

  bm.off('profile:state', testListener);
  bm._emitProfileState('profile_test_1', 'stopped', null);
  assert.strictEqual(emittedEvents.length, 1, 'Listener should not have received event after bm.off()');
  console.log('  -> BrowserManager EventEmitter verified successfully.\n');

  // 2. Setup API Server with BrowserManager
  console.log('[Step 2] Setting up API Server with BrowserManager...');
  const mockDb = {
    getProfiles: () => [],
    getProfile: () => null,
    getSetting: () => null,
    setSetting: () => {}
  };

  const server = createApiServer({
    db: mockDb,
    browserManager: bm
  });

  const initialBmListeners = bm.listenerCount('profile:state');
  assert.strictEqual(initialBmListeners, 1, 'Server should have registered 1 listener on browserManager for "profile:state"');

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address.port;
  console.log(`  -> Server listening on http://127.0.0.1:${port}`);

  // 3. Connect to SSE Endpoint /api/v1/events
  console.log('[Step 3] Connecting to SSE /api/v1/events...');
  let sseChunks = [];
  let sseEnded = false;
  let sseConnectedResolved = false;

  const sseReq = http.request({
    hostname: '127.0.0.1',
    port: port,
    path: '/api/v1/events',
    method: 'GET'
  });

  const connectedPromise = new Promise((resolve, reject) => {
    sseReq.on('response', (res) => {
      try {
        assert.strictEqual(res.statusCode, 200, `Expected 200, got ${res.statusCode}`);
        assert.strictEqual(res.headers['content-type'], 'text/event-stream; charset=utf-8');
        assert.strictEqual(res.headers['cache-control'], 'no-cache, no-transform');
        assert.strictEqual(res.headers['connection'], 'keep-alive');
        assert.strictEqual(res.headers['access-control-allow-origin'], '*');
      } catch (e) {
        return reject(e);
      }

      res.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        sseChunks.push(text);
        if (!sseConnectedResolved && text.includes(': connected\n\n')) {
          sseConnectedResolved = true;
          resolve(res);
        }
      });

      res.on('end', () => {
        sseEnded = true;
      });

      res.on('error', (err) => {
        // Expected on abrupt close
      });
    });

    sseReq.on('error', reject);
  });

  sseReq.end();

  const sseRes = await connectedPromise;
  console.log('  -> SSE Connected! Received initial handshake: ": connected\\n\\n"');

  // 4. Test Event Broadcasting through SSE
  console.log('[Step 4] Broadcasting "profile:state" events over SSE...');
  const nextChunkPromise = () => new Promise((resolve) => {
    const onData = (chunk) => {
      sseRes.removeListener('data', onData);
      resolve(chunk.toString('utf8'));
    };
    sseRes.on('data', onData);
  });

  // Emit "running" state
  let chunkWaiter = nextChunkPromise();
  bm._emitProfileState('p100', 'running', mockSession);
  let chunkText = await chunkWaiter;
  console.log('  -> Received SSE message (running):', JSON.stringify(chunkText));
  assert(chunkText.startsWith('event: profile-state\n'), 'Must have event: profile-state');
  const dataMatch1 = chunkText.match(/data: (.+)\n\n/);
  assert(dataMatch1, 'Must have data payload');
  const payload1 = JSON.parse(dataMatch1[1]);
  assert.strictEqual(payload1.profileId, 'p100');
  assert.strictEqual(payload1.state, 'running');
  assert.strictEqual(payload1.activeSession.pid, 99999);

  // Emit "closing" state
  chunkWaiter = nextChunkPromise();
  bm._emitProfileState('p100', 'closing', { ...mockSession, closing: true });
  chunkText = await chunkWaiter;
  console.log('  -> Received SSE message (closing):', JSON.stringify(chunkText));
  assert(chunkText.startsWith('event: profile-state\n'));
  const dataMatch2 = chunkText.match(/data: (.+)\n\n/);
  const payload2 = JSON.parse(dataMatch2[1]);
  assert.strictEqual(payload2.profileId, 'p100');
  assert.strictEqual(payload2.state, 'closing');
  assert.strictEqual(payload2.activeSession.closing, true);

  // Emit "stopped" state
  chunkWaiter = nextChunkPromise();
  bm._emitProfileState('p100', 'stopped', null);
  chunkText = await chunkWaiter;
  console.log('  -> Received SSE message (stopped):', JSON.stringify(chunkText));
  assert(chunkText.startsWith('event: profile-state\n'));
  const dataMatch3 = chunkText.match(/data: (.+)\n\n/);
  const payload3 = JSON.parse(dataMatch3[1]);
  assert.strictEqual(payload3.profileId, 'p100');
  assert.strictEqual(payload3.state, 'stopped');
  assert.strictEqual(payload3.activeSession, null);
  console.log('  -> SSE event delivery and serialization verified successfully.\n');

  // 5. Test server.close() cleanup
  console.log('[Step 5] Verifying server.close() behavior & SSE cleanup...');
  assert.strictEqual(bm.listenerCount('profile:state'), 1, 'Before close: listenerCount should be 1');

  const closePromise = new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  await closePromise;
  console.log('  -> server.close() callback completed.');

  assert.strictEqual(
    bm.listenerCount('profile:state'),
    0,
    'After close: browserManager listener for "profile:state" must be completely removed (0 listeners)'
  );

  // Give socket event loop brief tick to finish res.end
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(sseEnded, true, 'SSE client connection must have ended upon server.close()');

  // Verify server no longer accepts requests
  let connectionFailed = false;
  try {
    await new Promise((resolve, reject) => {
      const testReq = http.get(`http://127.0.0.1:${port}/api/v1/status`, (res) => {
        resolve(res);
      });
      testReq.on('error', reject);
    });
  } catch (err) {
    connectionFailed = true;
    console.log('  -> New connection properly rejected:', err.code || err.message);
  }
  assert(connectionFailed, 'Server should not accept connections after close');

  console.log('\n=== ALL BROWSER MANAGER & SSE TESTS PASSED (100%) ===');
}

main().catch((err) => {
  console.error('\n[TEST FAILED]:', err);
  process.exit(1);
});
