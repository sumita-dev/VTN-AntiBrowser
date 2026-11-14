const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseCookiesInput, mergeCookies, toCdpCookieParams } = require('../src/core/cookie-parser');
const { ProfileDatabase } = require('../src/core/db');
const { BrowserManager } = require('../src/core/browser-manager');
const { createApiServer } = require('../src/api/server');

async function run() {
  // 1. JSON format (J2TEAM { cookies: [...] } + sameSite: no_restriction)
  const j2Json = JSON.stringify({
    url: 'https://www.facebook.com',
    cookies: [
      { name: 'c_user', value: '100012345', domain: '.facebook.com', path: '/', secure: true, httpOnly: false, sameSite: 'no_restriction', expirationDate: 1800000000 },
      { name: 'xs', value: '32%3Aabc%3D', domain: '.facebook.com', path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction' }
    ]
  });
  const parsedJ2 = parseCookiesInput(j2Json);
  assert.strictEqual(parsedJ2.length, 2);
  assert.strictEqual(parsedJ2[0].sameSite, 'None');
  assert.strictEqual(parsedJ2[1].httpOnly, true);

  // 2. Netscape format with #HttpOnly_ (case-insensitive)
  const netscape = [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_.instagram.com\tTRUE\t/\tTRUE\t1800000000\tsessionid\t12345%3Aabcdef',
    '#httponly_.instagram.com\tTRUE\t/\tTRUE\t1800000000\tmid\tmid_val_123',
    '.instagram.com\tTRUE\t/\tTRUE\t1800000000\tdsr_id\t999'
  ].join('\n');
  const parsedNetscape = parseCookiesInput(netscape);
  assert.strictEqual(parsedNetscape.length, 3);
  assert.strictEqual(parsedNetscape[0].domain, '.instagram.com');
  assert.strictEqual(parsedNetscape[0].httpOnly, true);
  assert.strictEqual(parsedNetscape[0].name, 'sessionid');
  assert.strictEqual(parsedNetscape[1].httpOnly, true);
  assert.strictEqual(parsedNetscape[1].name, 'mid');

  // 3. Raw string auto-detection for FB, IG, X, TikTok
  const fbRaw = parseCookiesInput('c_user=100099; xs=abc==; datr=xyz;');
  assert.strictEqual(fbRaw.length, 3);
  assert.strictEqual(fbRaw[0].domain, '.facebook.com');
  assert.strictEqual(fbRaw[1].value, 'abc==');

  const xRaw = parseCookiesInput('auth_token=tok123; ct0=csrf456;');
  assert.strictEqual(xRaw.length, 2);
  assert.strictEqual(xRaw[0].domain, '.x.com');

  const ttRaw = parseCookiesInput('sid_tt=tt123; ttwid=tw456;');
  assert.strictEqual(ttRaw.length, 2);
  assert.strictEqual(ttRaw[0].domain, '.tiktok.com');

  // 4. CDP param conversion
  const cdpParams = toCdpCookieParams(parsedJ2);
  assert.strictEqual(cdpParams[0].expires, 1800000000);
  assert.strictEqual(cdpParams[1].httpOnly, true);

  // 5. Merge deduplication
  const merged = mergeCookies(fbRaw, [{ name: 'xs', value: 'updated_xs', domain: '.facebook.com', path: '/' }]);
  assert.strictEqual(merged.length, 3);
  assert.strictEqual(merged.find((c) => c.name === 'xs').value, 'updated_xs');

  // 6. End-to-end API routes (/api/v1/profiles + /api/v1/profiles/:id/cookies)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtn-cookie-test-'));
  const db = new ProfileDatabase(path.join(tmpDir, 'test.db'));
  const bm = new BrowserManager({ db, profilesDir: path.join(tmpDir, 'profiles') });
  const server = createApiServer({ db, browserManager: bm });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    const createRes = await fetch(`${baseUrl}/api/v1/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'FB Cookie Profile',
        rawCookies: 'c_user=10001; xs=secret1;',
        cookieDomain: '.facebook.com'
      })
    }).then((r) => r.json());
    assert.strictEqual(createRes.ok, true);
    assert.strictEqual(createRes.profile.cookies.length, 2);
    const pid = createRes.profile.id;

    // Merge X cookies onto same profile
    const mergeRes = await fetch(`${baseUrl}/api/v1/profiles/${encodeURIComponent(pid)}/cookies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawCookies: 'auth_token=x_tok; ct0=x_ct0;',
        mode: 'merge'
      })
    }).then((r) => r.json());
    assert.strictEqual(mergeRes.ok, true);
    assert.strictEqual(mergeRes.importedCount, 2);
    assert.strictEqual(mergeRes.totalCookies, 4);
    assert.strictEqual(mergeRes.injectedLive, false);

    // Get cookies
    const getRes = await fetch(`${baseUrl}/api/v1/profiles/${encodeURIComponent(pid)}/cookies`).then((r) => r.json());
    assert.strictEqual(getRes.ok, true);
    assert.strictEqual(getRes.count, 4);

    // Partial platform deletion (x.com)
    const delXRes = await fetch(`${baseUrl}/api/v1/profiles/${encodeURIComponent(pid)}/cookies?domain=x.com`, {
      method: 'DELETE'
    }).then((r) => r.json());
    assert.strictEqual(delXRes.ok, true);
    assert.strictEqual(delXRes.totalCookies, 2);
    assert.strictEqual(delXRes.removedCount, 2);
    assert.ok(delXRes.profile.cookies.every((c) => c.domain === '.facebook.com'));

    // Delete remaining cookies
    const delRes = await fetch(`${baseUrl}/api/v1/profiles/${encodeURIComponent(pid)}/cookies`, {
      method: 'DELETE'
    }).then((r) => r.json());
    assert.strictEqual(delRes.ok, true);
    assert.strictEqual(delRes.totalCookies, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (db.db && typeof db.db.close === 'function') db.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('ALL COOKIE IMPORT TESTS PASSED');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
