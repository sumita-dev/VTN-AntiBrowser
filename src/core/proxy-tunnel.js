/**
 * VNT-Browser Proxy Tunnel & GeoIP Synchronization (`src/core/proxy-tunnel.js`)
 * Manages local `Tool.exe` (GOST v2.11.2) SOCKS5/HTTP forwarders so Chromium never
 * triggers the proxy authentication dialog, and performs pre-flight GeoIP resolution
 * to synchronize `PublicIP`, `WebRTCAddress`, `TimeZone`, and `Geoposition`.
 */

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const DEFAULT_GOST_EXE = path.resolve(__dirname, '..', '..', 'bin', 'Tool.exe');

/**
 * Finds a free local TCP port bound to 127.0.0.1.
 *
 * @returns {Promise<number>}
 */
function getFreeLocalPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Waits until a local TCP port accepts connections or times out.
 *
 * @param {number} port
 * @param {number} [timeoutMs=4000]
 * @returns {Promise<boolean>}
 */
function waitForPortOpen(port, timeoutMs = 4000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tryConnect = () => {
      const sock = new net.Socket();
      sock.setTimeout(400);
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      const onFail = () => {
        sock.destroy();
        if (Date.now() - start >= timeoutMs) {
          resolve(false);
        } else {
          setTimeout(tryConnect, 100);
        }
      };
      sock.once('error', onFail);
      sock.once('timeout', onFail);
      sock.connect(port, '127.0.0.1');
    };
    tryConnect();
  });
}

/**
 * Parses a proxy configuration object or string (`type://user:pass@host:port` or `host:port:user:pass`).
 *
 * @param {Object|string|null} proxyInput
 * @returns {null|{ type: string, host: string, port: number, username: string, password: string }}
 */
function normalizeProxyConfig(proxyInput) {
  if (!proxyInput) return null;
  if (typeof proxyInput === 'object') {
    if (!proxyInput.host || !proxyInput.port || proxyInput.type === 'direct' || proxyInput.mode === 'direct') {
      return null;
    }
    let pType = (proxyInput.type || 'http').toLowerCase();
    if (pType === 'socks' || pType === 'socks5h') pType = 'socks5';
    return {
      type: pType,
      host: String(proxyInput.host).trim(),
      port: Number(proxyInput.port),
      username: proxyInput.username ? String(proxyInput.username) : '',
      password: proxyInput.password ? String(proxyInput.password) : ''
    };
  }

  const raw = String(proxyInput).trim();
  if (!raw || raw === 'direct') return null;

  try {
    if (raw.includes('://')) {
      const u = new URL(raw);
      let pType = u.protocol.replace(':', '').toLowerCase();
      if (pType === 'socks' || pType === 'socks5h') pType = 'socks5';
      return {
        type: pType,
        host: u.hostname,
        port: Number(u.port),
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || '')
      };
    }
  } catch {
    // Fallback to colon-separated format host:port:user:pass
  }

  const parts = raw.split(':');
  if (parts.length >= 2) {
    return {
      type: 'http',
      host: parts[0],
      port: Number(parts[1]),
      username: parts[2] || '',
      password: parts.slice(3).join(':') || ''
    };
  }
  return null;
}

/**
 * Starts a local `Tool.exe` (GOST) HTTP/SOCKS5 forwarder on `127.0.0.1:<freePort>`
 * forwarding to the upstream proxy (handling authentication transparently).
 *
 * @param {Object} proxyConfig
 * @param {string} [gostExePath]
 * @returns {Promise<{ localPort: number, chromeProxyArg: string, process: import('child_process').ChildProcess }>}
 */
async function startProxyTunnel(proxyConfig, gostExePath = DEFAULT_GOST_EXE) {
  const norm = normalizeProxyConfig(proxyConfig);
  if (!norm) {
    throw new Error('Invalid or empty proxy configuration.');
  }
  if (!fs.existsSync(gostExePath)) {
    throw new Error(`GOST binary not found at: ${gostExePath}`);
  }

  // Allocate a local port that responds to both HTTP proxy and SOCKS5 (`auto://127.0.0.1:PORT`)
  const localPort = await getFreeLocalPort();
  const authPart = norm.username
    ? `${encodeURIComponent(norm.username)}:${encodeURIComponent(norm.password || '')}@`
    : '';
  const upstreamUrl = `${norm.type}://${authPart}${norm.host}:${norm.port}`;

  // Use `http://127.0.0.1:<localPort>` for local listener so both Node HTTP client and Chrome `--proxy-server` can use it
  const args = [
    '-L', `http://127.0.0.1:${localPort}`,
    '-F', upstreamUrl
  ];

  const child = spawn(gostExePath, args, {
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true
  });
  child.on('error', () => {
    // Prevent unhandled error event if GOST fails to spawn
  });

  const opened = await waitForPortOpen(localPort, 4000);
  if (!opened) {
    try { child.kill(); } catch {}
    throw new Error(`Failed to start local proxy tunnel on 127.0.0.1:${localPort}`);
  }

  return {
    localPort,
    chromeProxyArg: `http://127.0.0.1:${localPort}`,
    process: child
  };
}

/**
 * Performs an HTTP GET request (optionally routed through a local HTTP proxy `127.0.0.1:localPort`)
 * to fetch JSON data.
 *
 * @param {string} targetUrl
 * @param {number|null} [localProxyPort=null]
 * @param {number} [timeoutMs=6000]
 * @returns {Promise<Object>}
 */
function fetchJsonViaLocalHttpProxy(targetUrl, localProxyPort = null, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const options = localProxyPort
      ? {
          host: '127.0.0.1',
          port: localProxyPort,
          path: targetUrl,
          method: 'GET',
          headers: {
            Host: parsed.host,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: timeoutMs
        }
      : {
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: timeoutMs
        };

    const transport = !localProxyPort && parsed.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid JSON response from GeoIP endpoint (${res.statusCode}): ${body.slice(0, 120)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error('GeoIP request timed out'));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Maps Country Code to default Accept-Language header & Langs list.
 */
const COUNTRY_TO_LANGS = {
  US: { langs: 'en-US,en', acceptLang: 'en-US,en;q=0.9' },
  GB: { langs: 'en-GB,en', acceptLang: 'en-GB,en;q=0.9' },
  CA: { langs: 'en-CA,en', acceptLang: 'en-CA,en;q=0.9' },
  AU: { langs: 'en-AU,en', acceptLang: 'en-AU,en;q=0.9' },
  DE: { langs: 'de-DE,de,en-US,en', acceptLang: 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7' },
  FR: { langs: 'fr-FR,fr,en-US,en', acceptLang: 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7' },
  JP: { langs: 'ja-JP,ja,en-US,en', acceptLang: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' },
  KR: { langs: 'ko-KR,ko,en-US,en', acceptLang: 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' },
  SG: { langs: 'en-SG,en', acceptLang: 'en-SG,en;q=0.9' },
  VN: { langs: 'vi-VN,vi,en-US,en', acceptLang: 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7' },
  NL: { langs: 'nl-NL,nl,en-US,en', acceptLang: 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7' }
};

/**
 * Resolves exit IP, TimeZone, Geoposition, and Country Code via `ip-api.com` (with fallback).
 *
 * @param {number|null} [localProxyPort=null]
 * @param {number} [timeoutMs=5000]
 * @returns {Promise<{
 *   ok: boolean,
 *   ip?: string,
 *   countryCode?: string,
 *   country?: string,
 *   city?: string,
 *   timeZone?: string,
 *   geoposition?: string,
 *   langs?: string,
 *   acceptLang?: string,
 *   error?: string
 * }>}
 */
async function resolveGeoIp(localProxyPort = null, timeoutMs = 5000) {
  try {
    const data = await fetchJsonViaLocalHttpProxy(
      'http://ip-api.com/json/?fields=status,message,country,countryCode,city,lat,lon,timezone,query',
      localProxyPort,
      timeoutMs
    );
    if (data && data.status === 'success' && data.query) {
      const cc = data.countryCode || 'US';
      const langInfo = COUNTRY_TO_LANGS[cc] || COUNTRY_TO_LANGS.US;
      return {
        ok: true,
        ip: data.query,
        countryCode: cc,
        country: data.country || '',
        city: data.city || '',
        timeZone: data.timezone || 'America/New_York',
        geoposition: `${data.lat ?? 40.7128},${data.lon ?? -74.0060},25`,
        langs: langInfo.langs,
        acceptLang: langInfo.acceptLang
      };
    }
    return { ok: false, error: (data && data.message) || 'GeoIP lookup returned non-success status' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Tests a proxy configuration end-to-end by spawning a temporary GOST tunnel,
 * resolving GeoIP through it, and shutting down the temporary tunnel.
 *
 * @param {Object|string} proxyInput
 * @returns {Promise<Object>}
 */
async function checkProxyConnectivity(proxyInput) {
  const norm = normalizeProxyConfig(proxyInput);
  if (!norm) {
    const directRes = await resolveGeoIp(null, 5000);
    return Object.assign({ mode: 'direct' }, directRes);
  }

  let tunnel = null;
  const startMs = Date.now();
  try {
    tunnel = await startProxyTunnel(norm);
    const geo = await resolveGeoIp(tunnel.localPort, 7000);
    const latencyMs = Date.now() - startMs;
    return Object.assign({ mode: norm.type, latencyMs }, geo);
  } catch (err) {
    return { ok: false, mode: norm.type, error: err.message };
  } finally {
    if (tunnel && tunnel.process) {
      try { tunnel.process.kill(); } catch {}
    }
  }
}

module.exports = {
  getFreeLocalPort,
  waitForPortOpen,
  normalizeProxyConfig,
  startProxyTunnel,
  resolveGeoIp,
  checkProxyConnectivity
};
