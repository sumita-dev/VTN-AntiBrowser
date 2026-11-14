const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const {
  normalizeProxyConfig,
  serializeProxyConfig,
  checkProxyConnectivity,
  resolveDirectGeoIpCached
} = require('../src/core/proxy-tunnel');
const { generateFingerprint } = require('../src/core/fingerprint-gen');
const { ProfileDatabase } = require('../src/core/db');

async function run() {
  console.log('=== [1/4] Testing Proxy Normalization & Serialization ===');
  assert.deepStrictEqual(serializeProxyConfig(''), { mode: 'direct' });
  assert.deepStrictEqual(serializeProxyConfig('direct'), { mode: 'direct' });
  assert.deepStrictEqual(serializeProxyConfig({ mode: 'direct' }), { mode: 'direct' });

  const s1 = serializeProxyConfig('socks5://u1:p1@10.0.0.1:1080');
  assert.deepStrictEqual(s1, {
    mode: 'proxy',
    type: 'socks5',
    host: '10.0.0.1',
    port: 1080,
    username: 'u1',
    password: 'p1'
  });

  const s2 = serializeProxyConfig('192.168.1.5:8080:u2:p2:extra');
  assert.deepStrictEqual(s2, {
    mode: 'proxy',
    type: 'http',
    host: '192.168.1.5',
    port: 8080,
    username: 'u2',
    password: 'p2:extra'
  });

  const s3 = serializeProxyConfig('u3:p3@203.0.113.10:3128');
  assert.deepStrictEqual(s3, {
    mode: 'proxy',
    type: 'http',
    host: '203.0.113.10',
    port: 3128,
    username: 'u3',
    password: 'p3'
  });

  const s4 = serializeProxyConfig('socks5://1.2.3.4:1080:user@domain.com:p@ss');
  assert.deepStrictEqual(s4, {
    mode: 'proxy',
    type: 'socks5',
    host: '1.2.3.4',
    port: 1080,
    username: 'user@domain.com',
    password: 'p@ss'
  });

  const s5 = serializeProxyConfig('1.2.3.4:8080:user@email.com:pass');
  assert.deepStrictEqual(s5, {
    mode: 'proxy',
    type: 'http',
    host: '1.2.3.4',
    port: 8080,
    username: 'user@email.com',
    password: 'pass'
  });

  assert.strictEqual(normalizeProxyConfig('1.2.3.4:abc'), null);
  assert.strictEqual(normalizeProxyConfig('1.2.3.4:70000'), null);
  assert.throws(() => serializeProxyConfig('bad-proxy-string'), /không hợp lệ/i);

  const badCheck = await checkProxyConnectivity('bad-proxy-string');
  assert.strictEqual(badCheck.ok, false);
  console.log('  [PASS] Proxy parsing, validation, and invalid-input guard verified.');

  console.log('=== [2/4] Testing No Fake IP/Geoposition Defaults ===');
  const fp = generateFingerprint({});
  assert.notStrictEqual(fp.dynamicConfig.PublicIP, '198.51.100.42');
  assert.notStrictEqual(fp.dynamicConfig.WebRTCAddress, '198.51.100.42');
  assert.notStrictEqual(fp.dynamicConfig.Geoposition, '40.7128,-74.0060,25');
  assert.strictEqual(fp.dynamicConfig.PublicIP, '');
  assert.strictEqual(fp.dynamicConfig.Geoposition, '');
  console.log('  [PASS] Fake RFC 5737 IP and hardcoded NY coordinates removed.');

  console.log('=== [3/4] Testing DB Profile Proxy Serialization & Safe Update ===');
  const tmpDbPath = path.join(os.tmpdir(), `vtn_proxy_test_${Date.now()}.db`);
  const db = new ProfileDatabase(tmpDbPath);
  try {
    const created = db.createProfile({
      name: 'Proxy Test Profile',
      proxyConfig: 'socks5://alice:secret@45.77.10.20:1080'
    });
    assert.strictEqual(created.autoGeoIp, true);
    assert.deepStrictEqual(created.proxyConfig, {
      mode: 'proxy',
      type: 'socks5',
      host: '45.77.10.20',
      port: 1080,
      username: 'alice',
      password: 'secret'
    });

    const origCanvas = created.fingerprint.switches.CanvasMark;
    const origRenderer = created.fingerprint.webglFp.UNMASKED_RENDERER_WEBGL;
    const origMac = created.fingerprint.staticConfig.MacAdderss;

    const updated = db.updateProfile(created.id, {
      proxyConfig: '45.77.10.21:8080:bob:pw',
      fingerprintOverrides: {
        timeZone: 'Asia/Ho_Chi_Minh',
        publicIp: '45.77.10.21',
        webRtcAddress: '45.77.10.21',
        geoposition: '10.8231,106.6297,25'
      }
    });

    assert.deepStrictEqual(updated.proxyConfig, {
      mode: 'proxy',
      type: 'http',
      host: '45.77.10.21',
      port: 8080,
      username: 'bob',
      password: 'pw'
    });
    assert.strictEqual(updated.fingerprint.switches.TimeZone, 'Asia/Ho_Chi_Minh');
    assert.strictEqual(updated.fingerprint.dynamicConfig.PublicIP, '45.77.10.21');
    assert.strictEqual(updated.fingerprint.switches.CanvasMark, origCanvas);
    assert.strictEqual(updated.fingerprint.webglFp.UNMASKED_RENDERER_WEBGL, origRenderer);
    assert.strictEqual(updated.fingerprint.staticConfig.MacAdderss, origMac);
    console.log('  [PASS] DB updateProfile preserves hardware/noise invariants while updating Proxy/GeoIP.');
  } finally {
    try { db.db.close(); } catch {}
    try { fs.unlinkSync(tmpDbPath); } catch {}
  }

  console.log('=== [4/5] Testing Legacy Stale IP Scrubbing Migration & Direct GeoIP Cache ===');
  const migrationDbPath = path.join(os.tmpdir(), `vtn_migration_test_${Date.now()}.db`);
  const rawDb = new DatabaseSync(migrationDbPath);
  try {
    rawDb.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        group_name TEXT DEFAULT 'Default',
        tags TEXT DEFAULT '[]',
        notes TEXT DEFAULT '',
        proxy_config TEXT DEFAULT '{"mode":"direct"}',
        auto_geoip INTEGER DEFAULT 0,
        start_url TEXT DEFAULT 'about:blank',
        fingerprint_json TEXT NOT NULL,
        cookies_json TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT DEFAULT NULL
      );
    `);

    const legacyFp = {
      switches: { TimeZone: 'America/New_York' },
      dynamicConfig: {
        PublicIP: '198.51.100.42',
        WebRTCAddress: '198.51.100.42',
        Geoposition: '40.7128,-74.0060,25'
      }
    };

    const insertStmt = rawDb.prepare(`
      INSERT INTO profiles (id, name, auto_geoip, fingerprint_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const nowIso = new Date().toISOString();
    insertStmt.run('legacy_user_profile', 'Legacy User Profile', 0, JSON.stringify(legacyFp), nowIso, nowIso);
    insertStmt.run('vnt_macos_m3', 'MacBook Pro M3 Max (Tokyo)', 0, JSON.stringify(legacyFp), nowIso, nowIso);
    rawDb.close();

    // Now instantiate ProfileDatabase which triggers initSchema() migration
    const migratedDb = new ProfileDatabase(migrationDbPath);
    try {
      const pLegacy = migratedDb.getProfile('legacy_user_profile');
      assert(pLegacy, 'legacy_user_profile should exist');
      assert.strictEqual(pLegacy.autoGeoIp, true, 'Normal legacy profile should have auto_geoip updated to true (1)');
      assert.strictEqual(pLegacy.fingerprint.dynamicConfig.PublicIP, '');
      assert.strictEqual(pLegacy.fingerprint.dynamicConfig.WebRTCAddress, '');
      assert.strictEqual(pLegacy.fingerprint.dynamicConfig.Geoposition, '');

      const pShowcase = migratedDb.getProfile('vnt_macos_m3');
      assert(pShowcase, 'vnt_macos_m3 should exist');
      assert.strictEqual(pShowcase.autoGeoIp, false, 'Showcase profile vnt_macos_m3 must preserve autoGeoIp=false');
      assert.strictEqual(pShowcase.fingerprint.dynamicConfig.PublicIP, '');
      assert.strictEqual(pShowcase.fingerprint.dynamicConfig.WebRTCAddress, '');
      assert.strictEqual(pShowcase.fingerprint.dynamicConfig.Geoposition, '');

      // Verify that raw SQLite rows are actually updated on disk
      const checkStmt = migratedDb.db.prepare("SELECT fingerprint_json, auto_geoip FROM profiles WHERE id = 'legacy_user_profile'");
      const rawRow = checkStmt.get();
      assert(!rawRow.fingerprint_json.includes('198.51.100.42'), 'Raw DB row must not contain 198.51.100.42');
      assert(!rawRow.fingerprint_json.includes('40.7128,-74.0060,25'), 'Raw DB row must not contain 40.7128,-74.0060,25');
      assert.strictEqual(rawRow.auto_geoip, 1, 'Raw DB row must have auto_geoip set to 1');

      console.log('  [PASS] Legacy DB migration automatically scrubbed 198.51.100.42 and enabled auto_geoip.');
    } finally {
      try { migratedDb.db.close(); } catch {}
    }
  } finally {
    try { fs.unlinkSync(migrationDbPath); } catch {}
  }

  // Also test resolveDirectGeoIpCached
  const t0 = Date.now();
  const geo1 = await resolveDirectGeoIpCached(3000);
  const dur1 = Date.now() - t0;
  const t1 = Date.now();
  const geo2 = await resolveDirectGeoIpCached(3000);
  const dur2 = Date.now() - t1;
  assert.strictEqual(typeof geo1, 'object');
  assert.strictEqual(typeof geo2, 'object');
  if (geo1.ok) {
    assert.strictEqual(geo1.ip, geo2.ip);
    assert.strictEqual(geo1.timeZone, geo2.timeZone);
    assert(dur2 < 50, `Subsequent cached call should be instantaneous (<50ms), got ${dur2}ms`);
    console.log(`  [PASS] resolveDirectGeoIpCached verified (cached response in ${dur2}ms, IP=${geo1.ip}, TZ=${geo1.timeZone}).`);
  } else {
    console.log('  [INFO] resolveDirectGeoIpCached returned network error (offline safe).');
  }

  console.log('=== [5/5] ALL PROXY & TIMEZONE TESTS PASSED ===');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
