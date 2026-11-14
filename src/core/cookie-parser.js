/**
 * VTN-Browser Multi-Format Cookie Parser & Normalizer (`src/core/cookie-parser.js`)
 * Supports:
 * 1. JSON array or `{ cookies: [...] }` (J2TEAM Cookies, Cookie-Editor, EditThisCookie, Playwright)
 * 2. Netscape HTTP Cookie File (tab-separated, including `#HttpOnly_` prefix)
 * 3. Raw `Cookie:` header string (`name1=val1; name2=val2;`) with auto-domain detection for FB/IG/X/TikTok
 */

const PLATFORM_DEFAULT_DOMAINS = {
  facebook: '.facebook.com',
  instagram: '.instagram.com',
  x: '.x.com',
  twitter: '.x.com',
  tiktok: '.tiktok.com'
};

/**
 * Infers a default cookie domain from well-known authentication cookie names
 * when parsing a raw `name=value;` string without explicit domain metadata.
 *
 * @param {Array<{name: string, value: string}>} pairs
 * @returns {string}
 */
function inferDomainFromPairs(pairs) {
  const names = new Set(pairs.map((p) => p.name.toLowerCase()));
  if (names.has('c_user') || names.has('xs') || names.has('datr') || names.has('sb')) {
    return '.facebook.com';
  }
  if (names.has('ds_user_id') || names.has('ig_did') || names.has('rur')) {
    return '.instagram.com';
  }
  if (names.has('auth_token') || names.has('ct0') || names.has('twid')) {
    return '.x.com';
  }
  if (names.has('sid_tt') || names.has('ttwid') || names.has('tt_csrf_token') || names.has('msToken'.toLowerCase())) {
    return '.tiktok.com';
  }
  if (names.has('sessionid')) {
    return '.instagram.com';
  }
  return '';
}

/**
 * Normalizes `sameSite` values across different cookie export tools into Chromium's
 * canonical values (`Strict`, `Lax`, `None`).
 *
 * @param {*} rawSameSite
 * @returns {'Strict'|'Lax'|'None'|undefined}
 */
function normalizeSameSite(rawSameSite) {
  if (!rawSameSite || typeof rawSameSite !== 'string') return undefined;
  const s = rawSameSite.trim().toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'lax') return 'Lax';
  if (s === 'none' || s === 'no_restriction') return 'None';
  return undefined;
}

/**
 * Normalizes a single cookie object into the standard format used by both
 * `ImportCookies.json` (`--protected-cookiesfile`) and CDP `Network.setCookies`.
 *
 * @param {Object} raw
 * @param {string} [defaultDomain]
 * @returns {Object|null}
 */
function normalizeCookieObject(raw, defaultDomain = '') {
  if (!raw || typeof raw !== 'object') return null;
  const name = raw.name !== undefined ? String(raw.name).trim() : '';
  const value = raw.value !== undefined ? String(raw.value) : '';
  if (!name) return null;

  let domain = raw.domain ? String(raw.domain).trim() : '';
  if (!domain && raw.url) {
    try {
      domain = new URL(raw.url).hostname;
    } catch {}
  }
  if (!domain) domain = defaultDomain;
  if (!domain) return null;

  const cookie = {
    name,
    value,
    domain,
    path: raw.path ? String(raw.path) : '/',
    secure: Boolean(raw.secure !== undefined ? raw.secure : true),
    httpOnly: Boolean(raw.httpOnly)
  };

  const sameSite = normalizeSameSite(raw.sameSite);
  if (sameSite) cookie.sameSite = sameSite;

  const rawExp = raw.expirationDate !== undefined ? raw.expirationDate : raw.expires;
  if (rawExp !== undefined && rawExp !== null && !raw.session) {
    const num = Number(rawExp);
    if (Number.isFinite(num) && num > 0) {
      cookie.expirationDate = num;
    }
  }

  return cookie;
}

/**
 * Parses Netscape HTTP Cookie File format.
 *
 * @param {string} text
 * @returns {Object[]}
 */
function parseNetscapeCookies(text) {
  const lines = text.split(/\r?\n/);
  const cookies = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    let httpOnly = false;
    let cleanLine = line;
    if (/^#httponly_/i.test(line)) {
      httpOnly = true;
      cleanLine = line.slice('#HttpOnly_'.length);
    } else if (line.startsWith('#')) {
      continue;
    }

    const parts = cleanLine.split('\t');
    if (parts.length < 7) continue;

    const [domain, , pathVal, secureStr, expStr, name, ...valueParts] = parts;
    const value = valueParts.join('\t');
    const expNum = Number(expStr);

    const normalized = normalizeCookieObject({
      domain,
      path: pathVal || '/',
      secure: String(secureStr).toUpperCase() === 'TRUE',
      httpOnly,
      expirationDate: Number.isFinite(expNum) && expNum > 0 ? expNum : undefined,
      name,
      value
    });

    if (normalized) cookies.push(normalized);
  }

  return cookies;
}

/**
 * Parses raw `name=value; name2=value2` cookie header strings.
 *
 * @param {string} text
 * @param {string} [defaultDomain]
 * @returns {Object[]}
 */
function parseRawCookieString(text, defaultDomain = '') {
  const cleaned = text.replace(/^cookie:\s*/i, '').trim();
  const tokens = cleaned.split(/[;\r\n]+/).map((t) => t.trim()).filter(Boolean);
  const pairs = [];

  for (const token of tokens) {
    const eqIdx = token.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = token.slice(0, eqIdx).trim();
    const value = token.slice(eqIdx + 1).trim();
    if (!name) continue;
    pairs.push({ name, value });
  }

  if (pairs.length === 0) return [];

  const resolvedDomain = defaultDomain || inferDomainFromPairs(pairs);
  if (!resolvedDomain) {
    throw new Error('Không xác định được domain cho chuỗi cookie raw. Vui lòng chọn nền tảng (Facebook, Instagram, X, TikTok) hoặc nhập domain.');
  }

  return pairs
    .map((p) =>
      normalizeCookieObject({
        name: p.name,
        value: p.value,
        domain: resolvedDomain,
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'None'
      })
    )
    .filter(Boolean);
}

/**
 * Parses cookie input from JSON, Netscape, or raw `key=value;` string into
 * a deduplicated array of normalized cookie objects.
 *
 * @param {string|Object[]} input
 * @param {Object} [options]
 * @param {string} [options.defaultDomain] - e.g. '.facebook.com' or 'facebook'
 * @returns {Object[]}
 */
function parseCookiesInput(input, options = {}) {
  let defaultDomain = (options.defaultDomain || '').trim();
  if (defaultDomain && PLATFORM_DEFAULT_DOMAINS[defaultDomain.toLowerCase()]) {
    defaultDomain = PLATFORM_DEFAULT_DOMAINS[defaultDomain.toLowerCase()];
  }

  if (Array.isArray(input)) {
    return deduplicateCookies(
      input.map((item) => normalizeCookieObject(item, defaultDomain)).filter(Boolean)
    );
  }

  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return [];

  // 1. Try JSON format (J2TEAM Cookies, EditThisCookie, Cookie-Editor)
  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`JSON cookies không hợp lệ: ${err.message}`);
    }

    const list = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.cookies) ? parsed.cookies : null);

    if (!list) {
      throw new Error('JSON cookies phải là mảng `[...]` hoặc object `{ "cookies": [...] }`.');
    }

    const normalized = list.map((item) => normalizeCookieObject(item, defaultDomain)).filter(Boolean);
    if (normalized.length === 0) {
      throw new Error('Không tìm thấy cookie hợp lệ nào trong JSON.');
    }
    return deduplicateCookies(normalized);
  }

  // 2. Try Netscape tab-separated format
  if (text.includes('\t')) {
    const netscapeCookies = parseNetscapeCookies(text);
    if (netscapeCookies.length > 0) {
      return deduplicateCookies(netscapeCookies);
    }
  }

  // 3. Fallback to raw `name=value;` string
  const rawCookies = parseRawCookieString(text, defaultDomain);
  if (rawCookies.length === 0) {
    throw new Error('Không nhận diện được định dạng cookie. Hỗ trợ JSON (J2TEAM/Cookie-Editor), Netscape hoặc chuỗi `name=value;`.');
  }
  return deduplicateCookies(rawCookies);
}

/**
 * Deduplicates cookies by `(domain, path, name)` keeping the latest entry.
 *
 * @param {Object[]} cookies
 * @returns {Object[]}
 */
function deduplicateCookies(cookies) {
  const map = new Map();
  for (const c of cookies) {
    const key = `${c.domain}|${c.path || '/'}|${c.name}`;
    map.set(key, c);
  }
  return Array.from(map.values());
}

/**
 * Merges incoming cookies onto existing cookies by `(domain, path, name)`.
 *
 * @param {Object[]} existing
 * @param {Object[]} incoming
 * @returns {Object[]}
 */
function mergeCookies(existing, incoming) {
  return deduplicateCookies([...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]);
}

/**
 * Converts normalized cookies to CDP `Network.setCookies` parameter objects.
 *
 * @param {Object[]} cookies
 * @returns {Object[]}
 */
function toCdpCookieParams(cookies) {
  return cookies.map((c) => {
    const param = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly)
    };
    if (c.sameSite) param.sameSite = c.sameSite;
    if (c.expirationDate && Number.isFinite(Number(c.expirationDate))) {
      param.expires = Number(c.expirationDate);
    }
    return param;
  });
}

module.exports = {
  PLATFORM_DEFAULT_DOMAINS,
  parseCookiesInput,
  deduplicateCookies,
  mergeCookies,
  toCdpCookieParams
};
