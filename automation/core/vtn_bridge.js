/**
 * VTN-Browser CDP Bridge & Direct Browser Manager Integration
 * Enables opening profiles and interacting with CDP over WebSocket.
 */

const http = require('http');
const { BrowserManager } = require('../../src/core/browser-manager');
const { ProfileDatabase } = require('../../src/core/db');

function fetchCdpJson(port, endpoint = '/json', timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${endpoint}`, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP request timeout')));
  });
}

class VtnBridge {
  constructor(options = {}) {
    this.apiBaseUrl = options.apiBaseUrl || 'http://127.0.0.1:45678';
    this.db = options.db || new ProfileDatabase();
    this.browserManager = options.browserManager || new BrowserManager({ db: this.db });
  }

  async openProfile(profileId, options = {}) {
    try {
      const launchInfo = await this.browserManager.openProfile(profileId, options);
      return launchInfo;
    } catch (err) {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/profile/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, ...options })
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || err.message);
      return json.data;
    }
  }

  async closeProfile(profileId) {
    try {
      return await this.browserManager.closeProfile(profileId);
    } catch {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/profile/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId })
      });
      const json = await res.json();
      return json.ok;
    }
  }

  async getActivePageWs(debuggingPort) {
    const targets = await fetchCdpJson(debuggingPort, '/json', 2000);
    const pageTarget = Array.isArray(targets) ? targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : null;
    return pageTarget ? pageTarget.webSocketDebuggerUrl : null;
  }

  async executeCdpCommands(wsUrl, commands = []) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let id = 1;
      const responses = [];

      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('CDP execution timed out'));
      }, 15000);

      ws.addEventListener('open', () => {
        for (const cmd of commands) {
          ws.send(JSON.stringify({ id: id++, ...cmd }));
        }
      });

      ws.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data));
          responses.push(msg);
          if (responses.length >= commands.length) {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve(responses);
          }
        } catch (e) {
          // ignore
        }
      });

      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async injectCookies(wsUrl, cookies = []) {
    const validCookies = cookies.map((c) => {
      const item = {
        name: c.name,
        value: c.value,
        domain: c.domain || '.facebook.com',
        path: c.path || '/'
      };
      if (c.secure !== undefined) item.secure = Boolean(c.secure);
      if (c.httpOnly !== undefined) item.httpOnly = Boolean(c.httpOnly);
      if (c.sameSite) item.sameSite = c.sameSite;
      if (c.expires && c.expires > 0) item.expires = c.expires;
      return item;
    });

    const commands = [
      { method: 'Network.enable', params: {} },
      { method: 'Network.setCookies', params: { cookies: validCookies } }
    ];

    return await this.executeCdpCommands(wsUrl, commands);
  }
}

module.exports = { VtnBridge };
