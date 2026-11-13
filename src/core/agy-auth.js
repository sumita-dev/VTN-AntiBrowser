/**
 * Antigravity (AGY) Google OAuth 2.0 Authentication Core
 * Implements Dual-Stack Loopback HTTP Server, Manual Callback, and Multi-Account storage
 * per ANTIGRAVITY_AUTH_BLUEPRINT.md
 */

const http = require('http');
const { URL, URLSearchParams } = require('url');
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.AGY_CLIENT_SECRET || '';
const USER_AGENT = 'vscode/1.X.X (Antigravity/4.3.0)';

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode'
].join(' ');

const ACCOUNTS_STORAGE_PATH = path.resolve(__dirname, '..', '..', 'data', 'agy_accounts.json');
const LEGACY_TOKEN_STORAGE_PATH = path.resolve(__dirname, '..', '..', 'data', 'agy_oauth_token.json');
const TOKEN_REFRESH_SKEW_SECONDS = 900; // 15 phut

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeJwtEmail(idToken) {
  if (typeof idToken !== 'string' || !idToken.includes('.')) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return (payload && payload.email) ? String(payload.email) : null;
  } catch {
    return null;
  }
}

function parseLocalTokenPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tokenObj = (typeof raw.token === 'object' && raw.token !== null) ? raw.token : null;
  const accessToken = tokenObj
    ? tokenObj.access_token
    : (typeof raw.token === 'string' ? raw.token : raw.access_token);
  const refreshToken = (tokenObj && tokenObj.refresh_token) || raw.refresh_token || null;

  let expiryTimestamp = Date.now() + 3600 * 1000;
  if (tokenObj && tokenObj.expiry) {
    const parsed = new Date(tokenObj.expiry).getTime();
    if (Number.isFinite(parsed)) expiryTimestamp = parsed;
  } else if (raw.expiry) {
    const parsed = new Date(raw.expiry).getTime();
    if (Number.isFinite(parsed)) expiryTimestamp = parsed;
  } else if (Number.isFinite(Number(raw.expiry_timestamp))) {
    expiryTimestamp = Number(raw.expiry_timestamp);
  } else if (Number.isFinite(Number(raw.expires_at))) {
    expiryTimestamp = Number(raw.expires_at);
  }

  const email = raw.email || decodeJwtEmail(raw.id_token) || null;
  if (!accessToken && !refreshToken) return null;

  return {
    access_token: accessToken || '',
    refresh_token: refreshToken || null,
    expiry_timestamp: expiryTimestamp,
    email,
    auth_method: raw.auth_method || 'antigravity_local'
  };
}

class AntigravityAuth {
  constructor() {
    this.activeFlow = null;
  }

  _loadStore() {
    try {
      if (fs.existsSync(ACCOUNTS_STORAGE_PATH)) {
        const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_STORAGE_PATH, 'utf8'));
        return {
          activeId: parsed.activeId || null,
          pendingEmails: Array.isArray(parsed.pendingEmails) ? parsed.pendingEmails : [],
          accounts: Array.isArray(parsed.accounts) ? parsed.accounts : []
        };
      }
    } catch {}

    // Migrate legacy single-token file if present and not disconnected
    try {
      if (fs.existsSync(LEGACY_TOKEN_STORAGE_PATH)) {
        const legacy = JSON.parse(fs.readFileSync(LEGACY_TOKEN_STORAGE_PATH, 'utf8'));
        if (legacy && !legacy.disconnected && (legacy.access_token || legacy.refresh_token)) {
          const id = legacy.id || crypto.randomUUID();
          const store = {
            activeId: id,
            pendingEmails: [],
            accounts: [{
              id,
              email: legacy.email || 'Google User',
              access_token: legacy.access_token || '',
              refresh_token: legacy.refresh_token || null,
              expiry_timestamp: legacy.expiry_timestamp || Date.now() + 3600 * 1000,
              auth_method: legacy.auth_method || 'antigravity_oauth',
              addedAt: legacy.addedAt || Date.now()
            }]
          };
          this._saveStore(store);
          return store;
        }
      }
    } catch {}

    return { activeId: null, pendingEmails: [], accounts: [] };
  }

  _saveStore(store) {
    fs.mkdirSync(path.dirname(ACCOUNTS_STORAGE_PATH), { recursive: true });
    fs.writeFileSync(ACCOUNTS_STORAGE_PATH, JSON.stringify({
      activeId: store.activeId || null,
      pendingEmails: Array.isArray(store.pendingEmails) ? store.pendingEmails : [],
      accounts: Array.isArray(store.accounts) ? store.accounts : []
    }, null, 2), 'utf8');
  }

  _sanitizeAccount(acc, activeId) {
    const isExpired = Boolean(acc.expiry_timestamp && acc.expiry_timestamp < Date.now());
    return {
      id: acc.id,
      email: acc.email || 'Google User',
      authMethod: acc.auth_method || 'antigravity_oauth',
      isExpired,
      isActive: acc.id === activeId,
      addedAt: acc.addedAt || Date.now()
    };
  }

  saveAccount(tokenData) {
    const store = this._loadStore();
    const rawEmail = (tokenData.email || '').trim();
    const email = rawEmail || 'Google User';
    const emailLower = email.toLowerCase();

    let existingIdx = -1;
    if (rawEmail) {
      existingIdx = store.accounts.findIndex(
        (a) => (a.email || '').trim().toLowerCase() === emailLower
      );
    }
    if (existingIdx === -1 && tokenData.id) {
      existingIdx = store.accounts.findIndex((a) => a.id === tokenData.id);
    }

    const now = Date.now();
    const existing = existingIdx >= 0 ? store.accounts[existingIdx] : null;
    const id = (existing && existing.id) || tokenData.id || crypto.randomUUID();

    const accountRecord = {
      id,
      email,
      access_token: tokenData.access_token || (existing && existing.access_token) || '',
      refresh_token: tokenData.refresh_token || (existing && existing.refresh_token) || null,
      expiry_timestamp: tokenData.expiry_timestamp || (existing && existing.expiry_timestamp) || (now + 3600 * 1000),
      auth_method: tokenData.auth_method || (existing && existing.auth_method) || 'antigravity_oauth',
      addedAt: (existing && existing.addedAt) || tokenData.addedAt || now
    };
    delete accountRecord.disconnected;

    if (existingIdx >= 0) {
      store.accounts[existingIdx] = accountRecord;
    } else {
      store.accounts.push(accountRecord);
    }

    store.activeId = id;
    if (rawEmail) {
      store.pendingEmails = store.pendingEmails.filter(
        (e) => String(e).trim().toLowerCase() !== emailLower
      );
    }

    this._saveStore(store);

    // Clear legacy disconnected state if present
    try {
      if (fs.existsSync(LEGACY_TOKEN_STORAGE_PATH)) {
        const legacy = JSON.parse(fs.readFileSync(LEGACY_TOKEN_STORAGE_PATH, 'utf8'));
        if (legacy && legacy.disconnected) {
          fs.writeFileSync(LEGACY_TOKEN_STORAGE_PATH, JSON.stringify(accountRecord, null, 2), 'utf8');
        }
      }
    } catch {}

    return this._sanitizeAccount(accountRecord, store.activeId);
  }

  listAccounts() {
    const store = this._loadStore();
    return store.accounts.map((acc) => this._sanitizeAccount(acc, store.activeId));
  }

  setActiveAccount(idOrEmail) {
    const target = String(idOrEmail || '').trim();
    if (!target) throw new Error('Thiếu ID hoặc email tài khoản');
    const store = this._loadStore();
    const targetLower = target.toLowerCase();
    const found = store.accounts.find(
      (a) => a.id === target || (a.email || '').trim().toLowerCase() === targetLower
    );
    if (!found) {
      throw new Error(`Không tìm thấy tài khoản: ${target}`);
    }
    store.activeId = found.id;
    this._saveStore(store);
    return this._sanitizeAccount(found, store.activeId);
  }

  removeAccount(idOrEmail) {
    const target = String(idOrEmail || '').trim();
    if (!target) throw new Error('Thiếu ID hoặc email tài khoản');
    const store = this._loadStore();
    const targetLower = target.toLowerCase();
    const beforeLen = store.accounts.length;
    store.accounts = store.accounts.filter(
      (a) => a.id !== target && (a.email || '').trim().toLowerCase() !== targetLower
    );
    if (store.accounts.length === beforeLen) {
      throw new Error(`Không tìm thấy tài khoản để xóa: ${target}`);
    }
    if (!store.accounts.some((a) => a.id === store.activeId)) {
      store.activeId = store.accounts.length > 0 ? store.accounts[0].id : null;
    }
    this._saveStore(store);
    return this.listAccounts();
  }

  getPendingAccounts() {
    const store = this._loadStore();
    return store.pendingEmails;
  }

  savePendingAccounts(emails) {
    const list = Array.isArray(emails) ? emails : [];
    const seen = new Set();
    const cleaned = [];
    for (const item of list) {
      const trimmed = String(item || '').trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      cleaned.push(trimmed);
    }
    const store = this._loadStore();
    store.pendingEmails = cleaned;
    this._saveStore(store);
    return cleaned;
  }

  getSavedToken() {
    const store = this._loadStore();
    if (store.accounts.length > 0) {
      const active = store.accounts.find((a) => a.id === store.activeId) || store.accounts[0];
      return active || null;
    }
    return null;
  }

  saveToken(tokenData) {
    return this.saveAccount(tokenData);
  }

  clearToken() {
    try {
      const store = this._loadStore();
      store.activeId = null;
      store.accounts = [];
      this._saveStore(store);
    } catch {}
    try {
      fs.mkdirSync(path.dirname(LEGACY_TOKEN_STORAGE_PATH), { recursive: true });
      fs.writeFileSync(
        LEGACY_TOKEN_STORAGE_PATH,
        JSON.stringify({ disconnected: true, disconnectedAt: Date.now() }, null, 2),
        'utf8'
      );
    } catch {}
  }

  async getAuthStatus() {
    const store = this._loadStore();
    const accounts = store.accounts.map((acc) => this._sanitizeAccount(acc, store.activeId));
    const pendingEmails = store.pendingEmails;
    const activeAcc = store.accounts.find((a) => a.id === store.activeId) || store.accounts[0] || null;

    if (!activeAcc || (!activeAcc.access_token && !activeAcc.refresh_token)) {
      return {
        authenticated: false,
        email: null,
        authMethod: null,
        isExpired: false,
        accounts,
        pendingEmails,
        activeId: store.activeId || null
      };
    }

    const isExpired = Boolean(activeAcc.expiry_timestamp && activeAcc.expiry_timestamp < Date.now());
    return {
      authenticated: !isExpired || Boolean(activeAcc.refresh_token),
      email: activeAcc.email || 'Google User',
      authMethod: activeAcc.auth_method || 'antigravity_oauth',
      isExpired,
      accounts,
      pendingEmails,
      activeId: activeAcc.id
    };
  }

  async getValidAccessToken() {
    let token = this.getSavedToken();
    if (!token) throw new Error('Chưa đăng nhập Google qua Antigravity 2.0');

    const now = Date.now();
    if (token.expiry_timestamp && token.expiry_timestamp < now && !token.refresh_token) {
      throw new Error('Google OAuth Token đã hết hạn và không có refresh_token');
    }
    const needsRefresh = !token.access_token || (token.expiry_timestamp && (token.expiry_timestamp - now < TOKEN_REFRESH_SKEW_SECONDS * 1000));

    if (needsRefresh && token.refresh_token) {
      const refreshed = await this._requestRefreshToken(token.refresh_token);
      const updated = {
        ...token,
        access_token: refreshed.access_token,
        expiry_timestamp: refreshed.expiry_timestamp,
        refresh_token: refreshed.refresh_token || token.refresh_token
      };
      this.saveAccount(updated);
      return updated.access_token;
    }
    return token.access_token;
  }

  async _requestRefreshToken(refreshToken) {
    let lastError = 'Không thể làm mới Google OAuth Token qua Antigravity';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        })
      });

      if (res.ok) {
        const data = await res.json();
        return {
          access_token: data.access_token,
          expiry_timestamp: Date.now() + (data.expires_in || 3600) * 1000,
          refresh_token: data.refresh_token || refreshToken
        };
      }

      const errText = await res.text().catch(() => '');
      lastError = `Refresh failed (${res.status}): ${errText}`;
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
    }
    throw new Error(lastError);
  }

  async refreshToken(refreshToken) {
    const refreshed = await this._requestRefreshToken(refreshToken);
    const existing = this.getSavedToken() || {};
    const updated = {
      ...existing,
      access_token: refreshed.access_token,
      expiry_timestamp: refreshed.expiry_timestamp,
      refresh_token: refreshed.refresh_token || refreshToken
    };
    this.saveAccount(updated);
    return updated;
  }

  async _fetchUserEmail(accessToken) {
    if (!accessToken) return null;
    try {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        if (userData && userData.email) return String(userData.email).trim();
      }
    } catch {}
    return null;
  }

  async _exchangeCodeForAccount(code, port) {
    const redirectUri = `http://localhost:${port}/oauth-callback`;
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${JSON.stringify(tokenData)}`);
    }

    const fetchedEmail = await this._fetchUserEmail(tokenData.access_token);
    const email = fetchedEmail || decodeJwtEmail(tokenData.id_token) || 'Google User';

    const fullToken = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expiry_timestamp: Date.now() + (tokenData.expires_in || 3600) * 1000,
      email,
      auth_method: 'antigravity_oauth'
    };
    return this.saveAccount(fullToken);
  }

  _closeActiveFlow() {
    if (!this.activeFlow) return;
    const servers = Array.isArray(this.activeFlow.servers)
      ? this.activeFlow.servers
      : (this.activeFlow.server ? [this.activeFlow.server] : []);
    for (const srv of servers) {
      try { srv.close(); } catch {}
    }
    this.activeFlow = null;
  }

  async startOAuthFlow(options = {}) {
    this._closeActiveFlow();

    const stateToken = crypto.randomUUID();
    const openBrowser = options.openBrowser !== false;
    const pendingEmail = typeof options.pendingEmail === 'string' ? options.pendingEmail.trim() : '';
    let boundPort = 0;

    const handleRequest = async (req, res) => {
      try {
        const reqUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
        if (reqUrl.pathname !== '/oauth-callback') {
          res.writeHead(404).end('Not Found');
          return;
        }

        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');

        if (state !== stateToken || !code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`
            <div style="font-family: -apple-system, sans-serif; text-align: center; padding: 50px;">
              <h1 style="color: #ef4444;">Xác thực thất bại!</h1>
              <p>State không khớp hoặc mã xác thực không hợp lệ.</p>
            </div>
          `);
          return;
        }

        const saved = await this._exchangeCodeForAccount(code, boundPort);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif; text-align: center; padding: 60px 20px; background: #0b0f19; color: #fff; min-height: 100vh;">
            <div style="max-width: 480px; margin: 0 auto; background: #16202e; border: 1px solid rgba(255, 107, 0, 0.4); border-radius: 20px; padding: 40px; box-shadow: 0 20px 50px rgba(0,0,0,0.6);">
              <div style="font-size: 54px; margin-bottom: 20px;">🎉</div>
              <h2 style="font-size: 24px; font-weight: 700; color: #ff8a00; margin-bottom: 12px;">Đăng Nhập Antigravity Thành Công!</h2>
              <p style="font-size: 15px; color: #94a3b8; line-height: 1.5; margin-bottom: 24px;">Đã kết nối tài khoản Google <strong>${escapeHtml(saved.email)}</strong> vào VTN Anti-Browser.</p>
              <div style="display: inline-block; background: rgba(16, 185, 129, 0.15); border: 1px solid #10b981; color: #34d399; padding: 8px 18px; border-radius: 20px; font-size: 13px; font-weight: 600;">
                ✓ Sẵn sàng điều khiển AI
              </div>
              <p style="font-size: 13px; color: #64748b; margin-top: 24px;">Bạn có thể đóng tab trình duyệt này và quay lại Dashboard.</p>
            </div>
          </div>
        `);

        this._closeActiveFlow();
      } catch (err) {
        this._closeActiveFlow();
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>Lỗi: ${escapeHtml(err && err.message ? err.message : err)}</h1>`);
      }
    };

    const listenOnHost = (port, host) => new Promise((resolve, reject) => {
      const srv = http.createServer(handleRequest);
      const onError = (err) => {
        srv.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        srv.removeListener('error', onError);
        const addr = srv.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve({ server: srv, port: actualPort });
      };
      srv.once('error', onError);
      srv.once('listening', onListening);
      srv.listen(port, host);
    });

    // Dual-stack binding: try IPv6 [::1]:0 first, fallback to IPv4 127.0.0.1:0,
    // then bind the other protocol on the same port.
    let primary = null;
    let isPrimaryIpv6 = false;
    try {
      primary = await listenOnHost(0, '::1');
      isPrimaryIpv6 = true;
    } catch {
      primary = await listenOnHost(0, '127.0.0.1');
      isPrimaryIpv6 = false;
    }

    boundPort = primary.port;
    const servers = [primary.server];
    const otherHost = isPrimaryIpv6 ? '127.0.0.1' : '::1';
    try {
      const secondary = await listenOnHost(boundPort, otherHost);
      servers.push(secondary.server);
    } catch {
      // Ignore error if secondary protocol stack is unavailable
    }

    const redirectUri = `http://localhost:${boundPort}/oauth-callback`;
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', stateToken);
    if (pendingEmail) {
      authUrl.searchParams.set('login_hint', pendingEmail);
    }

    const authUrlStr = authUrl.toString();
    this.activeFlow = {
      port: boundPort,
      stateToken,
      authUrl: authUrlStr,
      servers
    };

    if (openBrowser) {
      const startCmd = process.platform === 'win32'
        ? `start "" "${authUrlStr}"`
        : `open "${authUrlStr}"`;
      exec(startCmd);
    }

    return { url: authUrlStr, port: boundPort, state: stateToken };
  }

  async completeManualCallback(callbackUrl) {
    if (!this.activeFlow) {
      throw new Error('Chưa có phiên OAuth đang chờ. Vui lòng bấm "Bắt đầu xác thực OAuth" trước.');
    }

    let parsed;
    try {
      parsed = new URL(String(callbackUrl || '').trim());
    } catch {
      throw new Error('URL callback không hợp lệ. Vui lòng dán đầy đủ URL bắt đầu bằng http://localhost:...');
    }

    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    if (!code) {
      throw new Error('URL callback thiếu tham số code.');
    }
    if (!state || state !== this.activeFlow.stateToken) {
      throw new Error('State trong URL callback không khớp với phiên OAuth hiện tại.');
    }

    const port = this.activeFlow.port;
    const saved = await this._exchangeCodeForAccount(code, port);
    this._closeActiveFlow();
    return saved;
  }

  async importJsonAccounts(input) {
    let parsed = input;
    if (typeof input === 'string') {
      const trimmed = input.trim();
      if (!trimmed) throw new Error('Dữ liệu JSON trống.');
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        throw new Error('JSON không hợp lệ: ' + err.message);
      }
    }

    let entries = [];
    if (Array.isArray(parsed)) {
      entries = parsed;
    } else if (parsed && Array.isArray(parsed.accounts)) {
      entries = parsed.accounts;
    } else if (parsed && typeof parsed === 'object') {
      entries = [parsed];
    } else {
      throw new Error('Định dạng JSON không được hỗ trợ.');
    }

    let importedCount = 0;
    for (const entry of entries) {
      const normalized = parseLocalTokenPayload(entry);
      if (!normalized) continue;

      let accessToken = normalized.access_token;
      let refreshToken = normalized.refresh_token;
      let expiryTimestamp = normalized.expiry_timestamp;
      let email = normalized.email;

      const isExpired = expiryTimestamp && expiryTimestamp < Date.now();
      if (refreshToken && (!accessToken || isExpired)) {
        try {
          const refreshed = await this._requestRefreshToken(refreshToken);
          accessToken = refreshed.access_token;
          expiryTimestamp = refreshed.expiry_timestamp;
          refreshToken = refreshed.refresh_token || refreshToken;
        } catch (err) {
          if (!accessToken) continue;
        }
      }

      if (!email && accessToken) {
        email = await this._fetchUserEmail(accessToken);
      }

      this.saveAccount({
        access_token: accessToken,
        refresh_token: refreshToken,
        expiry_timestamp: expiryTimestamp,
        email: email || 'Google User',
        auth_method: entry.auth_method || 'json_import'
      });
      importedCount++;
    }

    return {
      importedCount,
      accounts: this.listAccounts()
    };
  }

  async importFromLocalAntigravity() {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const candidatePaths = [
      path.join(home, '.gemini', 'jetski-standalone-oauth-token'),
      path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
    ];

    let importedCount = 0;
    for (const filePath of candidatePaths) {
      if (!filePath || !fs.existsSync(filePath)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const normalized = parseLocalTokenPayload(raw);
        if (!normalized) continue;

        let accessToken = normalized.access_token;
        let refreshToken = normalized.refresh_token;
        let expiryTimestamp = normalized.expiry_timestamp;
        let email = normalized.email;

        const isExpired = expiryTimestamp && expiryTimestamp < Date.now();
        if (refreshToken && (!accessToken || isExpired)) {
          try {
            const refreshed = await this._requestRefreshToken(refreshToken);
            accessToken = refreshed.access_token;
            expiryTimestamp = refreshed.expiry_timestamp;
            refreshToken = refreshed.refresh_token || refreshToken;
          } catch {}
        }

        if (!email && accessToken) {
          email = await this._fetchUserEmail(accessToken);
        }

        if (accessToken || refreshToken) {
          this.saveAccount({
            access_token: accessToken,
            refresh_token: refreshToken,
            expiry_timestamp: expiryTimestamp,
            email: email || 'antigravity-user@google.com',
            auth_method: 'antigravity_local'
          });
          importedCount++;
        }
      } catch {}
    }

    return {
      importedCount,
      accounts: this.listAccounts()
    };
  }
}

module.exports = { AntigravityAuth, CLIENT_ID, SCOPES };
