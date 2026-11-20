/**
 * VNT-Browser Cloudflare R2 / S3-Compatible Client (`src/core/r2-client.js`)
 * Implements AWS Signature Version 4 (SigV4) using zero external dependencies
 * (pure Node.js `node:crypto` and standard global `fetch`).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./paths');

const DEFAULT_R2_CONFIG_PATH = path.join(DATA_DIR, 'r2_config.json');

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function rfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

class R2Client {
  constructor(options = {}) {
    this.endpoint = (options.endpoint || '').replace(/\/+$/, '');
    this.accessKeyId = options.accessKeyId || '';
    this.secretAccessKey = options.secretAccessKey || '';
    this.bucket = options.bucket || 'vtn-antibrowser';
    this.region = options.region || 'auto';
    this.enabled = options.enabled !== undefined ? Boolean(options.enabled) : true;
  }

  static fromConfigFile(configPath = DEFAULT_R2_CONFIG_PATH) {
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const cfg = JSON.parse(raw);
        return new R2Client(cfg);
      } catch (err) {
        console.error('[R2Client] Error reading config file:', err.message);
      }
    }
    return new R2Client({ enabled: false });
  }

  isConfigured() {
    return Boolean(this.enabled && this.endpoint && this.accessKeyId && this.secretAccessKey && this.bucket);
  }

  /**
   * Internal AWS SigV4 signed HTTP request helper.
   */
  async _s3Request({ method, key = '', query = {}, body = null, contentType = null }) {
    if (!this.isConfigured()) {
      throw new Error('R2 client is not properly configured or is disabled');
    }

    const urlObj = new URL(this.endpoint);
    const host = urlObj.host;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const cleanKey = String(key || '').replace(/^\/+/, '');
    const pathSegments = [this.bucket];
    if (cleanKey) {
      for (const seg of cleanKey.split('/')) {
        if (seg) pathSegments.push(seg);
      }
    }
    const canonicalUri = '/' + pathSegments.map((s) => rfc3986(s)).join('/');

    const queryKeys = Object.keys(query).sort();
    const canonicalQuery = queryKeys.map((k) => rfc3986(k) + '=' + rfc3986(String(query[k]))).join('&');

    let payloadBuffer;
    if (body === null || body === undefined) {
      payloadBuffer = Buffer.alloc(0);
    } else if (Buffer.isBuffer(body)) {
      payloadBuffer = body;
    } else {
      payloadBuffer = Buffer.from(String(body), 'utf8');
    }
    const payloadHash = sha256Hex(payloadBuffer);

    const headers = {
      'host': host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate
    };
    if (contentType) {
      headers['content-type'] = contentType;
    }

    const sortedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderKeys.map((k) => k.toLowerCase() + ':' + headers[k].trim() + '\n').join('');
    const signedHeaders = sortedHeaderKeys.map((k) => k.toLowerCase()).join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join('\n');

    const kDate = hmac('AWS4' + this.secretAccessKey, dateStamp);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, 's3');
    const kSigning = hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    const authHeader = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const fullUrl = this.endpoint + canonicalUri + (canonicalQuery ? '?' + canonicalQuery : '');
    const fetchHeaders = {
      ...headers,
      'Authorization': authHeader
    };

    const res = await fetch(fullUrl, {
      method,
      headers: fetchHeaders,
      body: (method === 'GET' || method === 'HEAD') ? undefined : payloadBuffer
    });

    return res;
  }

  /**
   * Upload an object to R2.
   *
   * @param {string} key
   * @param {Buffer|string} body
   * @param {string} [contentType='application/octet-stream']
   * @returns {Promise<{ ok: boolean, status: number, etag: string }>}
   */
  async putObject(key, body, contentType = 'application/octet-stream') {
    const res = await this._s3Request({
      method: 'PUT',
      key,
      body,
      contentType
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`R2 putObject("${key}") failed with status ${res.status}: ${errText}`);
    }

    return {
      ok: true,
      status: res.status,
      etag: (res.headers.get('etag') || '').replace(/^"|"$/g, '')
    };
  }

  /**
   * Get an object from R2. Returns null if object does not exist (404).
   *
   * @param {string} key
   * @returns {Promise<{ ok: boolean, status: number, body: Buffer, contentType: string, etag: string }|null>}
   */
  async getObject(key) {
    const res = await this._s3Request({
      method: 'GET',
      key
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`R2 getObject("${key}") failed with status ${res.status}: ${errText}`);
    }

    const arrayBuf = await res.arrayBuffer();
    return {
      ok: true,
      status: res.status,
      body: Buffer.from(arrayBuf),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      etag: (res.headers.get('etag') || '').replace(/^"|"$/g, '')
    };
  }

  /**
   * Check metadata / existence of an object in R2. Returns null on 404.
   *
   * @param {string} key
   * @returns {Promise<{ ok: boolean, status: number, contentLength: number, contentType: string, lastModified: string, etag: string }|null>}
   */
  async headObject(key) {
    const res = await this._s3Request({
      method: 'HEAD',
      key
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      return null;
    }

    return {
      ok: true,
      status: res.status,
      contentLength: Number(res.headers.get('content-length') || 0),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      lastModified: res.headers.get('last-modified'),
      etag: (res.headers.get('etag') || '').replace(/^"|"$/g, '')
    };
  }

  /**
   * Delete an object from R2.
   *
   * @param {string} key
   * @returns {Promise<{ ok: boolean, status: number }>}
   */
  async deleteObject(key) {
    const res = await this._s3Request({
      method: 'DELETE',
      key
    });

    if (!res.ok && res.status !== 404) {
      const errText = await res.text();
      throw new Error(`R2 deleteObject("${key}") failed with status ${res.status}: ${errText}`);
    }

    return {
      ok: true,
      status: res.status
    };
  }

  /**
   * List objects with prefix.
   *
   * @param {string} [prefix='']
   * @returns {Promise<Array<{ key: string, size: number, lastModified: string, etag: string }>>}
   */
  async listObjects(prefix = '') {
    const query = { 'list-type': '2' };
    if (prefix) {
      query.prefix = prefix;
    }

    const res = await this._s3Request({
      method: 'GET',
      query
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`R2 listObjects("${prefix}") failed with status ${res.status}: ${errText}`);
    }

    const xml = await res.text();
    const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
    const items = [];
    let match;
    while ((match = contentsRegex.exec(xml)) !== null) {
      const block = match[1];
      const keyMatch = block.match(/<Key>(.*?)<\/Key>/);
      const sizeMatch = block.match(/<Size>(\d+)<\/Size>/);
      const lastModifiedMatch = block.match(/<LastModified>(.*?)<\/LastModified>/);
      const etagMatch = block.match(/<ETag>(.*?)<\/ETag>/);
      if (keyMatch) {
        items.push({
          key: keyMatch[1],
          size: sizeMatch ? Number(sizeMatch[1]) : 0,
          lastModified: lastModifiedMatch ? lastModifiedMatch[1] : null,
          etag: etagMatch ? etagMatch[1].replace(/^&quot;|"|&quot;$/g, '') : null
        });
      }
    }
    return items;
  }
}

module.exports = {
  R2Client,
  DEFAULT_R2_CONFIG_PATH
};
