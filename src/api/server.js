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
const { AntigravityAuth } = require('../core/agy-auth');
const { DEFAULT_FLASH_MODELS } = require('../../automation/ai/gemini');
const agyAuth = new AntigravityAuth();

function maskApiKey(k) {
  if (!k || typeof k !== 'string') return '';
  if (k.length >= 12) return k.slice(0, 6) + '••••••' + k.slice(-4);
  return '••••••••';
}

function extractRawApiKeys(cfg) {
  const candidates = [];
  if (cfg && Array.isArray(cfg.apiKeys)) {
    for (const k of cfg.apiKeys) candidates.push(k);
  }
  if (cfg && typeof cfg.apiKey === 'string' && cfg.apiKey) {
    candidates.push(cfg.apiKey);
  }
  const seen = new Set();
  const result = [];
  for (const raw of candidates) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function sanitizeAiConfigResponse(cfg) {
  const rawKeys = extractRawApiKeys(cfg);
  const maskedKeys = rawKeys.map(maskApiKey);
  const models = (cfg && Array.isArray(cfg.models) && cfg.models.length > 0)
    ? cfg.models
    : DEFAULT_FLASH_MODELS;
  const out = Object.assign({}, cfg, {
    apiKey: maskedKeys[0] || '',
    apiKeys: maskedKeys,
    apiKeysMasked: maskedKeys,
    apiKeyCount: rawKeys.length,
    hasApiKey: rawKeys.length > 0,
    models,
    defaultModels: DEFAULT_FLASH_MODELS
  });
  return out;
}

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
  const sseClients = new Set();

  const broadcastProfileState = (payload) => {
    if (sseClients.size === 0) return;
    const message = `event: profile-state\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(message);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  if (browserManager && typeof browserManager.on === 'function') {
    browserManager.on('profile:state', broadcastProfileState);
  }

  const sseHeartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, 25000);
  if (typeof sseHeartbeat.unref === 'function') sseHeartbeat.unref();

  const cleanupSse = () => {
    clearInterval(sseHeartbeat);
    if (browserManager && typeof browserManager.off === 'function') {
      browserManager.off('profile:state', broadcastProfileState);
    }
    for (const client of sseClients) {
      try { client.end(); } catch {}
    }
    sseClients.clear();
  };

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

      // 2. System Status, Realtime SSE Events & Blueprints
      if (req.method === 'GET' && pathname === '/api/v1/events') {
        if (typeof req.setTimeout === 'function') req.setTimeout(0);
        if (typeof res.setTimeout === 'function') res.setTimeout(0);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        const removeClient = () => sseClients.delete(res);
        req.on('close', removeClient);
        res.on('close', removeClient);
        res.on('error', removeClient);
        return;
      }

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
                  startedAt: sess.startedAt,
                  closing: Boolean(sess.closing)
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

      // 7. 1-Line Sync Key & Chromium Kernel Cloud Sync
      if (req.method === 'GET' && pathname === '/api/v1/cloud/sync-key') {
        const origin = req.headers['origin'];
        if (origin) {
          const isAllowedOrigin = origin.startsWith('http://127.0.0.1') || origin.startsWith('http://localhost');
          if (!isAllowedOrigin) {
            return sendJson(res, 403, { ok: false, error: 'Forbidden: Origin not allowed to access sync key' });
          }
        }
        if (!browserManager.cloudSync) {
          return sendJson(res, 200, { ok: false, error: 'CloudSync service is unavailable' });
        }
        const syncKey = browserManager.cloudSync.exportSyncKey();
        return sendJson(res, 200, {
          ok: Boolean(syncKey),
          syncKey: syncKey || null,
          message: syncKey ? 'Exported Sync Key' : 'R2 configuration is incomplete or missing'
        });
      }

      if (req.method === 'POST' && pathname === '/api/v1/cloud/import-key') {
        if (!browserManager.cloudSync) {
          return sendJson(res, 500, { ok: false, error: 'CloudSync service is unavailable' });
        }
        const body = await readJsonBody(req);
        const syncKey = body.syncKey || body.key;
        if (!syncKey) {
          return sendJson(res, 400, { ok: false, error: 'Missing syncKey parameter' });
        }
        try {
          const importRes = browserManager.cloudSync.importSyncKey(syncKey);
          const status = await browserManager.cloudSync.getCloudStatus();
          return sendJson(res, 200, {
            ok: true,
            saved: importRes.config,
            status
          });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'GET' && pathname === '/api/v1/cloud/kernel/status') {
        if (!browserManager.cloudSync || !browserManager.cloudSync.isEnabled()) {
          const localKernelPath = path.resolve(__dirname, '..', '..', 'bin', '151-0007', 'chrome.exe');
          return sendJson(res, 200, {
            ok: true,
            exists: false,
            hasLocalKernel: fs.existsSync(localKernelPath),
            message: 'Cloudflare R2 is disabled or not configured'
          });
        }
        const kernelInfo = await browserManager.cloudSync.hasKernelOnCloud();
        const localKernelPath = path.resolve(__dirname, '..', '..', 'bin', '151-0007', 'chrome.exe');
        return sendJson(res, 200, {
          ok: true,
          ...kernelInfo,
          hasLocalKernel: fs.existsSync(localKernelPath)
        });
      }

      if (req.method === 'POST' && pathname === '/api/v1/cloud/kernel/upload') {
        if (!browserManager.cloudSync || !browserManager.cloudSync.isEnabled()) {
          return sendJson(res, 400, { ok: false, error: 'Cloudflare R2 is disabled or not configured' });
        }
        await readJsonBody(req);
        const binBaseDir = path.resolve(__dirname, '..', '..', 'bin');
        try {
          const result = await browserManager.cloudSync.uploadKernel(binBaseDir);
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/cloud/kernel/download') {
        if (!browserManager.cloudSync || !browserManager.cloudSync.isEnabled()) {
          return sendJson(res, 400, { ok: false, error: 'Cloudflare R2 is disabled or not configured' });
        }
        await readJsonBody(req);
        const binBaseDir = path.resolve(__dirname, '..', '..', 'bin');
        try {
          const result = await browserManager.cloudSync.downloadKernel(binBaseDir);
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      
      // 7. AI Automation & Antigravity 2.0 Google OAuth Hub
      if (req.method === 'GET' && pathname === '/api/v1/ai/status') {
        const authStatus = await agyAuth.getAuthStatus();
        const aiConfigPath = path.resolve(__dirname, '..', '..', 'data', 'ai_config.json');
        let savedConfig = {
          persona: 'Ban la nguoi dung mang xa hoi tu nhien, tich cuc, binh luan ngan gon sat noi dung.',
          autoLike: true,
          autoComment: true,
          autoJoinGroup: true,
          locale: 'VN',
          maxChars: 120,
          targetGroups: [],
          apiKey: '',
          apiKeys: [],
          models: DEFAULT_FLASH_MODELS
        };
        if (fs.existsSync(aiConfigPath)) {
          try { savedConfig = Object.assign({}, savedConfig, JSON.parse(fs.readFileSync(aiConfigPath, 'utf8'))); } catch (e) {}
        }
        return sendJson(res, 200, { ok: true, auth: authStatus, config: sanitizeAiConfigResponse(savedConfig) });
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/oauth/login') {
        try {
          const body = await readJsonBody(req);
          const flow = await agyAuth.startOAuthFlow({
            openBrowser: body.openBrowser !== false,
            pendingEmail: body.pendingEmail || ''
          });
          return sendJson(res, 200, { ok: true, url: flow.url, port: flow.port, state: flow.state });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/oauth/callback-manual') {
        try {
          const body = await readJsonBody(req);
          const account = await agyAuth.completeManualCallback(body.callbackUrl);
          const auth = await agyAuth.getAuthStatus();
          return sendJson(res, 200, { ok: true, account, auth });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/oauth/logout') {
        agyAuth.clearToken();
        return sendJson(res, 200, { ok: true, message: 'Đã ngắt kết nối Antigravity OAuth' });
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/accounts/pending') {
        try {
          const body = await readJsonBody(req);
          const pendingEmails = agyAuth.savePendingAccounts(body.pendingEmails || []);
          return sendJson(res, 200, { ok: true, pendingEmails });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/accounts/import-json') {
        try {
          const body = await readJsonBody(req);
          const result = await agyAuth.importJsonAccounts(body.jsonText ?? body.accounts ?? body);
          const auth = await agyAuth.getAuthStatus();
          return sendJson(res, 200, { ok: true, ...result, auth });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/accounts/import-local') {
        try {
          const result = await agyAuth.importFromLocalAntigravity();
          const auth = await agyAuth.getAuthStatus();
          return sendJson(res, 200, { ok: true, ...result, auth });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/accounts/select') {
        try {
          const body = await readJsonBody(req);
          agyAuth.setActiveAccount(body.id || body.email);
          const auth = await agyAuth.getAuthStatus();
          return sendJson(res, 200, { ok: true, auth });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/accounts/delete') {
        try {
          const body = await readJsonBody(req);
          agyAuth.removeAccount(body.id || body.email);
          const auth = await agyAuth.getAuthStatus();
          return sendJson(res, 200, { ok: true, auth });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/config') {
        const body = await readJsonBody(req);
        const aiConfigPath = path.resolve(__dirname, '..', '..', 'data', 'ai_config.json');
        let existingConfig = {};
        if (fs.existsSync(aiConfigPath)) {
          try {
            existingConfig = JSON.parse(fs.readFileSync(aiConfigPath, 'utf8')) || {};
          } catch (e) {}
        }
        const existingRawKeys = extractRawApiKeys(existingConfig);

        let resolvedKeys = existingRawKeys;
        if (Array.isArray(body.apiKeys)) {
          const nextKeys = [];
          const seen = new Set();
          for (const rawItem of body.apiKeys) {
            const item = typeof rawItem === 'string' ? rawItem.trim() : '';
            if (!item) continue;
            let resolved = item;
            if (item.includes('••••••') || item === '••••••••') {
              const matched = existingRawKeys.find((k) => maskApiKey(k) === item);
              if (matched) {
                resolved = matched;
              } else if (item === '••••••••' && existingRawKeys.length > 0) {
                resolved = existingRawKeys[0];
              } else {
                continue;
              }
            }
            if (!seen.has(resolved)) {
              seen.add(resolved);
              nextKeys.push(resolved);
            }
          }
          resolvedKeys = nextKeys;
        } else if (typeof body.apiKey === 'string') {
          const trimmedKey = body.apiKey.trim();
          if (!trimmedKey) {
            resolvedKeys = [];
          } else if (trimmedKey.includes('••••••') || trimmedKey === '••••••••') {
            const matched = existingRawKeys.find((k) => maskApiKey(k) === trimmedKey);
            resolvedKeys = matched ? [matched] : existingRawKeys;
          } else {
            resolvedKeys = [trimmedKey];
          }
        }

        const resolvedModels = (Array.isArray(body.models) && body.models.length > 0)
          ? body.models.map((m) => String(m || '').trim()).filter(Boolean)
          : (Array.isArray(existingConfig.models) && existingConfig.models.length > 0
              ? existingConfig.models
              : DEFAULT_FLASH_MODELS);

        const nextConfig = Object.assign({}, existingConfig, body, {
          apiKeys: resolvedKeys,
          apiKey: resolvedKeys[0] || '',
          models: resolvedModels.length > 0 ? resolvedModels : DEFAULT_FLASH_MODELS
        });
        delete nextConfig.apiKeysMasked;
        delete nextConfig.apiKeyCount;
        delete nextConfig.hasApiKey;
        delete nextConfig.defaultModels;

        fs.mkdirSync(path.dirname(aiConfigPath), { recursive: true });
        fs.writeFileSync(aiConfigPath, JSON.stringify(nextConfig, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, config: sanitizeAiConfigResponse(nextConfig) });
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/run-profile') {
        const body = await readJsonBody(req);
        const profileId = body.profileId || body.id;
        if (!profileId) return sendJson(res, 400, { ok: false, error: 'Missing profileId' });

        const accountsPath = path.resolve(__dirname, '..', '..', 'automation', 'config', 'accounts_facebook.json');
        let accounts = [];
        if (fs.existsSync(accountsPath)) {
          try { accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8')); } catch (e) {}
        }
        const acc = accounts.find(a => a.profileId === profileId) || accounts[0];
        if (!acc) return sendJson(res, 400, { ok: false, error: 'Chưa có cấu hình tài khoản cho profile này' });

        try {
          const { FacebookRunner } = require('../../automation/scenarios/facebook_runner');
          const runner = new FacebookRunner(Object.assign({}, acc, { profileId }));
          runner.runSession({ headless: false, allowComment: body.allowComment !== false })
            .catch(e => process.stderr.write('[AI Run Error]: ' + e.message + '\n'));

          return sendJson(res, 200, { ok: true, message: `Đã kích hoạt AI trên Profile ${profileId}` });
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
      }


      return sendJson(res, 404, { ok: false, error: `Route not found: ${req.method} ${pathname}` });
    } catch (err) {
      if (!res.headersSent) {
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }
  });

  const origClose = server.close.bind(server);
  server.close = (cb) => {
    cleanupSse();
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    return origClose(cb);
  };
  server.on('close', cleanupSse);

  return server;
}

module.exports = {
  createApiServer
};
