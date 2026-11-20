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
const { BIN_DIR, readUiAsset } = require('../core/paths');
const { VtnMcpServer, validateLocalOriginAndHost } = require('../core/mcp-server');
const { AiClient } = require('../core/ai-client');
const { auditProfile, applyAuditFix } = require('../core/ai-auditor');
const { generateMatrixPlan, applyMatrixPlan } = require('../core/ai-matrix-planner');
const { AiAccountWarmer, WARMING_PRESETS } = require('../core/ai-warmer');
const { WORKFLOW_EXAMPLES, generateWorkflow, runWorkflow } = require('../core/ai-workflow');
const { EXTRACTOR_PRESETS, extractFromProfiles } = require('../core/ai-extractor');
const { APP_VERSION } = require('../core/version');
const {
  checkForUpdate,
  publishRelease,
  downloadAndStageUpdate,
  rollbackUpdate
} = require('../core/app-updater');

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

function sendLocalOnlyJson(req, res, statusCode, payload, originCheck) {
  const guard = originCheck || validateLocalOriginAndHost(req);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (guard && guard.ok && guard.origin) {
    headers['Access-Control-Allow-Origin'] = guard.origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function createApiServer({ db, browserManager, uiDir, aiClient: injectedAiClient, updaterOptions = {} }) {
  const customUiDir = uiDir || undefined;
  const aiClient = injectedAiClient || new AiClient();
  const aiWarmer = new AiAccountWarmer({ db, browserManager, aiClient });
  const mcpServer = new VtnMcpServer({ db, browserManager, aiClient, aiWarmer });

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const pathname = urlObj.pathname;

    if (req.method === 'OPTIONS') {
      if (pathname === '/mcp') {
        const guard = validateLocalOriginAndHost(req);
        if (!guard.ok) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32001, message: guard.error }
          }));
        }
        const headers = {
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
          'Access-Control-Expose-Headers': 'Mcp-Session-Id'
        };
        if (guard.origin) {
          headers['Access-Control-Allow-Origin'] = guard.origin;
          headers['Vary'] = 'Origin';
        }
        res.writeHead(204, headers);
        return res.end();
      }

      if (pathname.startsWith('/api/v1/updater/')) {
        const guard = validateLocalOriginAndHost(req);
        if (!guard.ok) {
          return sendLocalOnlyJson(req, res, 403, { ok: false, error: guard.error }, guard);
        }
        const headers = {
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        };
        if (guard.origin) {
          headers['Access-Control-Allow-Origin'] = guard.origin;
          headers['Vary'] = 'Origin';
        }
        res.writeHead(204, headers);
        return res.end();
      }

      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
        'Access-Control-Expose-Headers': 'Mcp-Session-Id'
      });
      return res.end();
    }

    try {
      // 1. Serve Dashboard UI & Static Brand Assets (Favicon, Logo, Icons)
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const html = readUiAsset('index.html', customUiDir);
        if (html) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(html);
        }
      }

      if (req.method === 'GET' && (pathname === '/favicon.svg' || pathname === '/favicon.ico' || pathname.startsWith('/assets/'))) {
        const relativePath = pathname.replace(/^\/+/, '');
        const fileData = readUiAsset(relativePath, customUiDir);
        if (fileData) {
          const ext = path.extname(relativePath).toLowerCase();
          const mimeTypes = {
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.ico': 'image/x-icon',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8'
          };
          const contentType = mimeTypes[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' });
          return res.end(fileData);
        }
      }

      // 2. System Status & Blueprints
      if (req.method === 'GET' && pathname === '/api/v1/status') {
        return sendJson(res, 200, {
          ok: true,
          appVersion: APP_VERSION,
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
          const localKernelPath = path.join(BIN_DIR, '151-0007', 'chrome.exe');
          return sendJson(res, 200, {
            ok: true,
            exists: false,
            hasLocalKernel: fs.existsSync(localKernelPath),
            message: 'Cloudflare R2 is disabled or not configured'
          });
        }
        const kernelInfo = await browserManager.cloudSync.hasKernelOnCloud();
        const localKernelPath = path.join(BIN_DIR, '151-0007', 'chrome.exe');
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
        const binBaseDir = BIN_DIR;
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
        const binBaseDir = BIN_DIR;
        try {
          const result = await browserManager.cloudSync.downloadKernel(binBaseDir);
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      // 7.5 R2 1-Click App Updater
      if (req.method === 'GET' && pathname === '/api/v1/updater/check') {
        const guard = validateLocalOriginAndHost(req);
        if (!guard.ok) {
          return sendLocalOnlyJson(req, res, 403, { ok: false, error: guard.error }, guard);
        }
        try {
          const result = await checkForUpdate(browserManager.cloudSync, {
            currentVersion: updaterOptions.currentVersion || APP_VERSION,
            targetExePath: updaterOptions.targetExePath
          });
          return sendLocalOnlyJson(req, res, 200, result, guard);
        } catch (err) {
          return sendLocalOnlyJson(req, res, 400, { ok: false, error: err.message }, guard);
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/updater/publish') {
        const guard = validateLocalOriginAndHost(req);
        if (!guard.ok) {
          return sendLocalOnlyJson(req, res, 403, { ok: false, error: guard.error }, guard);
        }
        if (!browserManager.cloudSync || !browserManager.cloudSync.isEnabled()) {
          return sendLocalOnlyJson(req, res, 400, { ok: false, error: 'Cloudflare R2 is disabled or not configured' }, guard);
        }
        const body = await readJsonBody(req);
        const safeNotes = typeof body.notes === 'string' ? body.notes : '';
        try {
          const result = await publishRelease(browserManager.cloudSync, {
            exePath: updaterOptions.exePath,
            version: updaterOptions.currentVersion || APP_VERSION,
            notes: safeNotes
          });
          return sendLocalOnlyJson(req, res, 200, result, guard);
        } catch (err) {
          return sendLocalOnlyJson(req, res, 400, { ok: false, error: err.message }, guard);
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/updater/apply') {
        const guard = validateLocalOriginAndHost(req);
        if (!guard.ok) {
          return sendLocalOnlyJson(req, res, 403, { ok: false, error: guard.error }, guard);
        }
        if (!browserManager.cloudSync || !browserManager.cloudSync.isEnabled()) {
          return sendLocalOnlyJson(req, res, 400, { ok: false, error: 'Cloudflare R2 is disabled or not configured' }, guard);
        }
        const activeSessions = browserManager.listActiveSessions();
        if (activeSessions && activeSessions.length > 0) {
          return sendLocalOnlyJson(req, res, 409, {
            ok: false,
            error: `Đang có ${activeSessions.length} Profile trình duyệt đang chạy. Vui lòng đóng tất cả Profile trước khi cập nhật ứng dụng.`
          }, guard);
        }
        await readJsonBody(req);
        try {
          const result = await downloadAndStageUpdate(browserManager.cloudSync, {
            targetExePath: updaterOptions.targetExePath,
            minBytes: typeof updaterOptions.minBytes === 'number' ? updaterOptions.minBytes : 1024,
            autoRestartInSea: updaterOptions.autoRestartInSea !== false
          });
          return sendLocalOnlyJson(req, res, 200, result, guard);
        } catch (err) {
          return sendLocalOnlyJson(req, res, 400, { ok: false, error: err.message }, guard);
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/updater/rollback') {
        const guard = validateLocalOriginAndHost(req);
        if (!guard.ok) {
          return sendLocalOnlyJson(req, res, 403, { ok: false, error: guard.error }, guard);
        }
        const activeSessions = browserManager.listActiveSessions();
        if (activeSessions && activeSessions.length > 0) {
          return sendLocalOnlyJson(req, res, 409, {
            ok: false,
            error: `Đang có ${activeSessions.length} Profile trình duyệt đang chạy. Vui lòng đóng tất cả Profile trước khi khôi phục phiên bản cũ.`
          }, guard);
        }
        await readJsonBody(req);
        try {
          const result = await rollbackUpdate({
            targetExePath: updaterOptions.targetExePath,
            autoRestartInSea: updaterOptions.autoRestartInSea !== false
          });
          return sendLocalOnlyJson(req, res, 200, result, guard);
        } catch (err) {
          return sendLocalOnlyJson(req, res, 400, { ok: false, error: err.message }, guard);
        }
      }

      // 6. Antidetect MCP Server (Streamable HTTP 2025-03-26 for Antigravity 2.0)
      if (pathname === '/mcp') {
        let body = null;
        if (req.method === 'POST') {
          try {
            body = await readJsonBody(req);
          } catch (parseErr) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error: Invalid JSON payload' }
            }));
          }
        }
        return await mcpServer.handleHttpRequest(req, res, body);
      }

      if (req.method === 'GET' && pathname === '/api/v1/mcp/info') {
        const rawHost = req.headers.host || '';
        const addr = server.address();
        const fallbackPort = (addr && typeof addr === 'object' && addr.port) ? addr.port : 45678;
        const hostGuard = validateLocalOriginAndHost({ headers: { host: rawHost } });
        const safeHost = (rawHost && hostGuard.ok) ? rawHost : `127.0.0.1:${fallbackPort}`;
        const endpoint = `http://${safeHost}/mcp`;
        const stdioScriptPath = path.resolve(__dirname, '../mcp-stdio.js').replace(/\\/g, '/');
        return sendJson(res, 200, {
          ok: true,
          endpoint,
          stdioScriptPath,
          antigravityConfigPath: '~/.gemini/config/mcp_config.json',
          antigravityHttpConfig: {
            mcpServers: {
              'vtn-anti-browser': {
                url: endpoint
              }
            }
          },
          antigravityStdioConfig: {
            mcpServers: {
              'vtn-anti-browser': {
                command: 'node',
                args: [stdioScriptPath]
              }
            }
          },
          stats: mcpServer.getStats(),
          tools: mcpServer.getTools().map((t) => ({
            name: t.name,
            description: t.description
          }))
        });
      }

      // 8. VTN AI Studio — Provider Config & 5 AI Capabilities
      if (req.method === 'GET' && pathname === '/api/v1/ai/config') {
        return sendJson(res, 200, { ok: true, config: aiClient.getMaskedConfig() });
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/config') {
        const body = await readJsonBody(req);
        try {
          const config = aiClient.saveConfig(body || {});
          return sendJson(res, 200, { ok: true, config });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/test') {
        await readJsonBody(req);
        const result = await aiClient.testConnection();
        return sendJson(res, 200, { ok: true, result });
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/audit') {
        const body = await readJsonBody(req);
        const profileId = body.profileId || body.profile_id || body.id;
        if (!profileId) {
          return sendJson(res, 400, { ok: false, error: 'Missing profileId' });
        }
        try {
          const report = await auditProfile({
            db,
            browserManager,
            aiClient,
            profileId,
            platform: body.platform || 'General',
            checkProxy: body.checkProxy !== false
          });
          return sendJson(res, 200, { ok: true, report });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/audit/apply-fix') {
        const body = await readJsonBody(req);
        const profileId = body.profileId || body.profile_id || body.id;
        if (!profileId) {
          return sendJson(res, 400, { ok: false, error: 'Missing profileId' });
        }
        try {
          const result = applyAuditFix(db, profileId, body.suggestedPatch);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'GET' && pathname === '/api/v1/ai/audit/logs') {
        const profileId = urlObj.searchParams.get('profileId') || undefined;
        const limit = Number(urlObj.searchParams.get('limit')) || 20;
        const logs = db.listAuditLogs(profileId, limit);
        return sendJson(res, 200, { ok: true, logs });
      }

      if (req.method === 'GET' && pathname === '/api/v1/ai/warm/presets') {
        return sendJson(res, 200, { ok: true, presets: WARMING_PRESETS });
      }

      if (req.method === 'GET' && pathname === '/api/v1/ai/warm/status') {
        return sendJson(res, 200, { ok: true, jobs: aiWarmer.getStatus() });
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/warm/start') {
        const body = await readJsonBody(req);
        try {
          const result = aiWarmer.startWarming(body || {});
          return sendJson(res, 200, result);
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/warm/stop') {
        const body = await readJsonBody(req);
        const result = body && body.jobId
          ? aiWarmer.stopWarming(body.jobId)
          : aiWarmer.stopAll();
        return sendJson(res, result.ok === false ? 400 : 200, result);
      }

      if (req.method === 'GET' && pathname === '/api/v1/ai/workflows') {
        return sendJson(res, 200, {
          ok: true,
          workflows: db.listWorkflows(),
          examples: WORKFLOW_EXAMPLES
        });
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/workflow/generate') {
        const body = await readJsonBody(req);
        if (!body || !String(body.prompt || '').trim()) {
          return sendJson(res, 400, { ok: false, error: 'Missing prompt' });
        }
        try {
          const generated = await generateWorkflow({
            aiClient,
            prompt: body.prompt,
            name: body.name
          });
          const saved = body.save !== false
            ? db.saveWorkflow({
                name: generated.name,
                prompt: generated.prompt,
                steps: generated.steps
              })
            : {
                id: null,
                name: generated.name,
                prompt: generated.prompt,
                steps: generated.steps,
                healCount: 0
              };
          return sendJson(res, 200, { ok: true, workflow: saved, usedLlm: generated.usedLlm });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/workflow/run') {
        const body = await readJsonBody(req);
        const profileId = body.profileId || body.profile_id;
        if (!profileId) {
          return sendJson(res, 400, { ok: false, error: 'Missing profileId' });
        }
        const workflow = body.workflowId
          ? db.getWorkflow(body.workflowId)
          : body.workflow;
        if (!workflow) {
          return sendJson(res, 400, { ok: false, error: 'Workflow not found or missing' });
        }
        const result = await runWorkflow({
          db,
          browserManager,
          aiClient,
          workflow,
          profileId,
          enableSelfHeal: body.enableSelfHeal !== false
        });
        return sendJson(res, 200, { ok: result.ok, result });
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/v1/ai/workflows/')) {
        const workflowId = decodeURIComponent(pathname.replace('/api/v1/ai/workflows/', ''));
        if (!workflowId) {
          return sendJson(res, 400, { ok: false, error: 'Missing workflow id' });
        }
        const deleted = db.deleteWorkflow(workflowId);
        return sendJson(res, 200, { ok: true, deleted });
      }

      if (req.method === 'GET' && pathname === '/api/v1/ai/extract/presets') {
        return sendJson(res, 200, { ok: true, presets: EXTRACTOR_PRESETS });
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/extract') {
        const body = await readJsonBody(req);
        try {
          const result = await extractFromProfiles({
            db,
            browserManager,
            aiClient,
            profileIds: body.profileIds,
            urls: body.urls,
            fields: body.fields,
            mode: body.mode || 'dom'
          });
          return sendJson(res, 200, { ok: true, result });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/matrix/plan') {
        const body = await readJsonBody(req);
        try {
          const plan = await generateMatrixPlan({
            db,
            aiClient,
            goal: body.goal || '',
            count: body.count,
            platform: body.platform || 'General',
            region: body.region || 'US',
            proxiesText: body.proxiesText || ''
          });
          return sendJson(res, 200, { ok: true, plan });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && pathname === '/api/v1/ai/matrix/apply') {
        const body = await readJsonBody(req);
        if (!body || !Array.isArray(body.items) || body.items.length === 0) {
          return sendJson(res, 400, { ok: false, error: 'Missing or empty items array' });
        }
        try {
          const result = applyMatrixPlan(db, body.items);
          return sendJson(res, 201, { ok: true, ...result });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
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
