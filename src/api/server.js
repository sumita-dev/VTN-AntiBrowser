/**
 * VNT-Browser Local REST API & Dashboard Server (`src/api/server.js`)
 * Zero-dependency HTTP server providing:
 * - Modern Web UI Dashboard (`GET /`)
 * - Profile CRUD (`/api/v1/profiles`)
 * - Automation Launch & Close (`/api/v1/profile/open`, `/api/v1/profile/close`)
 * - Live CDP Fingerprint Probe (`/api/v1/profile/probe`)
 * - Proxy Connectivity & GeoIP Checker (`/api/v1/proxy/check`)
 * - Hardware Blueprints & Random Generator (`/api/v1/fingerprint/generate`, `/api/v1/blueprints`)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  HARDWARE_BLUEPRINTS,
  generateFingerprint,
  generateUniqueFingerprint,
  listValidHardwareCombinations
} = require('../core/fingerprint-gen');
const { checkProxyConnectivity } = require('../core/proxy-tunnel');
const { probeRunningProfile } = require('../core/cdp-probe');

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function createApiServer({ db, browserManager, uiDir }) {
  const resolvedUiDir = uiDir || path.resolve(__dirname, '..', 'ui');

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const pathname = urlObj.pathname;

    try {
      // 1. Serve Dashboard UI & Static Brand Assets (Favicon, Logo, Icons)
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const htmlPath = path.join(resolvedUiDir, 'index.html');
        if (fs.existsSync(htmlPath)) {
          const html = fs.readFileSync(htmlPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(html);
        }
      }

      if (req.method === 'GET' && (pathname === '/favicon.svg' || pathname === '/favicon.ico' || pathname.startsWith('/assets/'))) {
        const relativePath = pathname.replace(/^\/+/, '');
        const filePath = path.resolve(resolvedUiDir, relativePath);
        if (filePath.startsWith(resolvedUiDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          const mimeTypes = {
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.ico': 'image/x-icon',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8'
          };
          const contentType = mimeTypes[ext] || 'application/octet-stream';
          const fileData = fs.readFileSync(filePath);
          res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
          return res.end(fileData);
        }
      }

      // 2. System Status & Blueprints
      if (req.method === 'GET' && pathname === '/api/v1/status') {
        return sendJson(res, 200, {
          ok: true,
          kernelVersion: '151.0.7922.109',
          chromeExe: browserManager.chromeExe,
          activeSessions: browserManager.listActiveSessions()
        });
      }

      if (req.method === 'GET' && pathname === '/api/v1/blueprints') {
        const list = Object.values(HARDWARE_BLUEPRINTS).map((b) => ({
          id: b.id,
          label: b.label,
          category: b.category || 'Desktop',
          os: b.os,
          platform: b.platform,
          manufacturer: b.manufacturer,
          productType: b.productType,
          architecture: b.uaMetadata ? b.uaMetadata.architecture : 'x86',
          coresOptions: b.coresOptions,
          memoryOptions: b.memoryOptions,
          minMemoryByCores: b.minMemoryByCores || {},
          screens: b.screens,
          renderer: b.webgl.UNMASKED_RENDERER_WEBGL,
          vendor: b.webgl.UNMASKED_VENDOR_WEBGL,
          maxTextureSize: b.webgl.MAX_TEXTURE_SIZE
        }));
        const totalCombinations = listValidHardwareCombinations().length;
        return sendJson(res, 200, { ok: true, blueprints: list, totalCombinations });
      }

      if (req.method === 'POST' && pathname === '/api/v1/fingerprint/generate') {
        const body = await readJsonBody(req);
        const existingProfiles = db.listProfiles();
        const fp = body.ensureUnique === false
          ? generateFingerprint(body)
          : generateUniqueFingerprint(body, existingProfiles);
        return sendJson(res, 200, {
          ok: true,
          fingerprint: fp,
          comparedProfilesCount: existingProfiles.length
        });
      }

      if (req.method === 'POST' && pathname === '/api/v1/profiles/auto-create') {
        const body = await readJsonBody(req);
        const existingProfiles = db.listProfiles();
        const fp = generateUniqueFingerprint(body.fingerprintOverrides || {}, existingProfiles);
        const bp = HARDWARE_BLUEPRINTS[fp.blueprintId] || {};
        const shortGpu = (bp.label || fp.blueprintId || 'Profile')
          .replace(/^Windows \d+\/?\d* \([^)]+\) — /, 'Win ')
          .replace(/^Windows \d+ [A-Za-z ]+ — /, 'Win ')
          .replace(/^macOS [A-Za-z0-9 ()_]+ — /, 'Mac ')
          .replace(/ \([^)]+\)$/, '');
        const defaultName = body.name || `Auto #${existingProfiles.length + 1} — ${shortGpu} (${fp.switches.HardwareConcurrency}C/${fp.switches.DeviceMemory}G)`;

        const created = db.createProfile({
          name: defaultName,
          groupName: body.groupName || 'Auto Unique',
          startUrl: body.startUrl || 'about:blank',
          autoGeoIp: Boolean(body.autoGeoIp),
          proxyConfig: body.proxyConfig || { mode: 'direct' },
          fingerprint: fp
        });
        return sendJson(res, 201, {
          ok: true,
          profile: created,
          comparedProfilesCount: existingProfiles.length
        });
      }

      // 3. Profiles CRUD
      if (req.method === 'GET' && pathname === '/api/v1/profiles') {
        const profiles = db.listProfiles().map((p) => {
          const sess = browserManager.getSession(p.id);
          return Object.assign({}, p, {
            running: Boolean(sess),
            activeSession: sess
              ? {
                  pid: sess.chromeProcess ? sess.chromeProcess.pid : null,
                  debuggingPort: sess.debuggingPort,
                  browserWsEndpoint: sess.browserWsEndpoint,
                  pageWsEndpoint: sess.pageWsEndpoint,
                  startedAt: sess.startedAt
                }
              : null
          });
        });
        return sendJson(res, 200, { ok: true, profiles });
      }

      if (req.method === 'POST' && pathname === '/api/v1/profiles') {
        const body = await readJsonBody(req);
        const created = db.createProfile(body);
        return sendJson(res, 201, { ok: true, profile: created });
      }

      if (pathname.startsWith('/api/v1/profiles/')) {
        const profileId = decodeURIComponent(pathname.replace('/api/v1/profiles/', ''));
        if (req.method === 'GET') {
          const p = db.getProfile(profileId);
          if (!p) return sendJson(res, 404, { ok: false, error: 'Profile not found' });
          return sendJson(res, 200, { ok: true, profile: p, running: browserManager.isRunning(profileId) });
        }
        if (req.method === 'PUT') {
          const body = await readJsonBody(req);
          const updated = db.updateProfile(profileId, body);
          if (!updated) return sendJson(res, 404, { ok: false, error: 'Profile not found' });
          return sendJson(res, 200, { ok: true, profile: updated });
        }
        if (req.method === 'DELETE') {
          await browserManager.purgeProfileDiskData(profileId);
          const deleted = db.deleteProfile(profileId);
          return sendJson(res, 200, { ok: true, deleted });
        }
      }

      // 4. Open / Close / Probe Profile (Automation API)
      if (req.method === 'POST' && pathname === '/api/v1/profile/open') {
        const body = await readJsonBody(req);
        const profileId = body.profileId || body.profile_id || body.id;
        if (!profileId) {
          return sendJson(res, 400, { ok: false, error: 'Missing profileId' });
        }
        const launchInfo = await browserManager.openProfile(profileId, {
          headless: Boolean(body.headless),
          startUrl: body.startUrl,
          autoGeoIp: body.autoGeoIp,
          proxyConfig: body.proxyConfig || body.proxy
        });
        return sendJson(res, 200, { ok: true, data: launchInfo });
      }

      if (req.method === 'POST' && pathname === '/api/v1/profile/close') {
        const body = await readJsonBody(req);
        const profileId = body.profileId || body.profile_id || body.id;
        if (!profileId) {
          return sendJson(res, 400, { ok: false, error: 'Missing profileId' });
        }
        const closed = await browserManager.closeProfile(profileId);
        return sendJson(res, 200, { ok: true, closed });
      }

      if (req.method === 'POST' && pathname === '/api/v1/profile/probe') {
        const body = await readJsonBody(req);
        const profileId = body.profileId || body.profile_id || body.id;
        if (!browserManager.isRunning(profileId)) {
          return sendJson(res, 400, { ok: false, error: 'Profile is not currently running. Open it first.' });
        }
        const sess = browserManager.getSession(profileId);
        if (!sess) {
          return sendJson(res, 400, { ok: false, error: 'Profile is not currently running. Open it first.' });
        }
        const report = await probeRunningProfile(sess.debuggingPort);
        return sendJson(res, 200, { ok: true, report });
      }

      // 5. Proxy Connectivity & GeoIP Check
      if (req.method === 'POST' && pathname === '/api/v1/proxy/check') {
        const body = await readJsonBody(req);
        const result = await checkProxyConnectivity(body.proxy || body);
        return sendJson(res, 200, { ok: true, result });
      }

      // 6. Cloudflare R2 Multi-Machine Sync
      if (req.method === 'GET' && pathname === '/api/v1/cloud/config') {
        if (!browserManager.cloudSync) {
          return sendJson(res, 200, {
            ok: true,
            config: { enabled: false, endpoint: '', bucket: 'vtn-antibrowser', region: 'auto', accessKeyId: '', hasSecret: false }
          });
        }
        const config = browserManager.cloudSync.getMaskedConfig();
        return sendJson(res, 200, { ok: true, config });
      }

      if (req.method === 'POST' && pathname === '/api/v1/cloud/config') {
        if (!browserManager.cloudSync) {
          return sendJson(res, 500, { ok: false, error: 'CloudSync service is unavailable' });
        }
        const body = await readJsonBody(req);
        const saveRes = browserManager.cloudSync.saveConfig(body);
        const status = await browserManager.cloudSync.getCloudStatus();
        return sendJson(res, 200, {
          ok: true,
          saved: saveRes.config,
          status
        });
      }

      if (req.method === 'GET' && pathname === '/api/v1/cloud/status') {
        if (!browserManager.cloudSync) {
          return sendJson(res, 200, { ok: true, status: { enabled: false, connected: false } });
        }
        const status = await browserManager.cloudSync.getCloudStatus();
        return sendJson(res, 200, { ok: true, status });
      }

      if (req.method === 'POST' && pathname === '/api/v1/cloud/sync-all') {
        if (!browserManager.cloudSync || !browserManager.cloudSync.isEnabled()) {
          return sendJson(res, 400, { ok: false, error: 'Cloudflare R2 is disabled or not configured' });
        }
        const result = await browserManager.cloudSync.syncAllProfiles(db, browserManager.profilesDir);
        return sendJson(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && pathname === '/api/v1/cloud/upload') {
        const body = await readJsonBody(req);
        const profileId = body.profileId || body.profile_id || body.id;
        if (!profileId) {
          return sendJson(res, 400, { ok: false, error: 'Missing profileId' });
        }
        if (browserManager.isRunning(profileId)) {
          return sendJson(res, 400, { ok: false, error: 'Profile is currently running. Close it before uploading.' });
        }
        if (!browserManager.cloudSync || !browserManager.cloudSync.isEnabled()) {
          return sendJson(res, 400, { ok: false, error: 'Cloudflare R2 is disabled or not configured' });
        }
        const result = await browserManager.cloudSync.uploadProfileData(profileId, db, browserManager.profilesDir);
        return sendJson(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && pathname === '/api/v1/cloud/download') {
        const body = await readJsonBody(req);
        const profileId = body.profileId || body.profile_id || body.id;
        if (!profileId) {
          return sendJson(res, 400, { ok: false, error: 'Missing profileId' });
        }
        if (browserManager.isRunning(profileId)) {
          return sendJson(res, 400, { ok: false, error: 'Profile is currently running. Close it before downloading.' });
        }
        if (!browserManager.cloudSync || !browserManager.cloudSync.isEnabled()) {
          return sendJson(res, 400, { ok: false, error: 'Cloudflare R2 is disabled or not configured' });
        }
        const result = await browserManager.cloudSync.downloadProfileData(profileId, db, browserManager.profilesDir);
        return sendJson(res, 200, { ok: true, result });
      }

      return sendJson(res, 404, { ok: false, error: `Route not found: ${req.method} ${pathname}` });
    } catch (err) {
      if (!res.headersSent) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }
  });

  return server;
}

module.exports = {
  createApiServer
};
