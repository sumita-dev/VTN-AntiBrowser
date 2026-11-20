/**
 * VTN Anti-Browser AI Visual Extractor đa Profile (`src/core/ai-extractor.js`)
 * Distributes target URLs round-robin across multiple antidetect profiles, extracts structured
 * fields via DOM snapshot + LLM (`mode: 'dom'`), Screenshot + Vision LLM (`mode: 'vision'`),
 * or deterministic offline metadata fallback, and exports RFC 4180 CSV with UTF-8 BOM.
 */

const {
  navigatePage,
  getPageSnapshot,
  captureScreenshot
} = require('./cdp-controller');

const EXTRACTOR_PRESETS = [
  {
    id: 'product_pricing',
    label: 'Trích xuất Giá & Thông tin Sản phẩm',
    description:
      'Thu thập tên sản phẩm, giá bán, đơn vị tiền tệ, tình trạng kho và mô tả ngắn từ các trang sản phẩm TMĐT.',
    mode: 'dom',
    fields: ['product_name', 'price', 'currency', 'availability', 'summary'],
    sampleUrls: [
      'https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html',
      'https://books.toscrape.com/catalogue/tipping-the-velvet_999/index.html'
    ]
  },
  {
    id: 'marketing_content',
    label: 'Phân tích Nội dung Marketing & Landing Page',
    description:
      'Trích xuất thương hiệu, tiêu đề chính (Headline), thông điệp giá trị (Value Proposition), nút CTA và điểm nổi bật.',
    mode: 'vision',
    fields: ['brand_name', 'headline', 'value_proposition', 'primary_cta', 'key_highlights'],
    sampleUrls: [
      'https://news.ycombinator.com/',
      'https://en.wikipedia.org/wiki/Landing_page'
    ]
  }
];

function unwrapJsonResult(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') {
    if (raw.data && typeof raw.data === 'object') return raw.data;
    if (raw.json && typeof raw.json === 'object') return raw.json;
    return raw;
  }
  return null;
}

function validateHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Escapes a single cell value according to RFC 4180.
 */
function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  let str;
  if (typeof value === 'object') {
    try {
      str = JSON.stringify(value);
    } catch {
      str = String(value);
    }
  } else {
    str = String(value);
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Converts extracted rows into an RFC 4180 CSV string prefixed with UTF-8 BOM (`\uFEFF`)
 * for seamless Excel/Vietnamese UTF-8 compatibility.
 *
 * @param {string[]} fields
 * @param {Array<Object>} rows
 * @returns {string}
 */
function rowsToCsv(fields, rows) {
  const cols = Array.isArray(fields) ? fields.map((f) => String(f)) : [];
  const dataRows = Array.isArray(rows) ? rows : [];
  const lines = [cols.map(escapeCsvCell).join(',')];
  for (const row of dataRows) {
    const record = row && typeof row === 'object' ? row : {};
    const line = cols.map((col) => escapeCsvCell(record[col])).join(',');
    lines.push(line);
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

/**
 * Deterministic offline metadata extraction when no LLM provider is configured.
 */
function extractOfflineMetadata(snapshot, fields, fallbackUrl) {
  const url = snapshot?.url || fallbackUrl || '';
  const title = snapshot?.title || '';
  const textExcerpt = (snapshot?.textExcerpt || '').slice(0, 500);

  const row = {
    url,
    title,
    textExcerpt
  };

  for (const field of fields) {
    const key = String(field);
    const lower = key.toLowerCase();
    if (lower === 'url' || lower === 'link' || lower === 'href') {
      row[key] = url;
    } else if (
      lower === 'title' ||
      lower === 'headline' ||
      lower === 'product_name' ||
      lower === 'name' ||
      lower === 'brand_name'
    ) {
      row[key] = title;
    } else if (
      lower === 'textexcerpt' ||
      lower === 'text_excerpt' ||
      lower === 'summary' ||
      lower === 'description' ||
      lower === 'value_proposition' ||
      lower === 'content'
    ) {
      row[key] = textExcerpt;
    } else if (!(key in row)) {
      row[key] = '';
    }
  }

  return row;
}

/**
 * Normalizes an LLM-extracted object so every requested field is present.
 */
function normalizeExtractedRow(rawObj, fields, meta) {
  const source = rawObj && typeof rawObj === 'object' ? rawObj : {};
  const row = {
    _url: meta.url,
    _profileId: meta.profileId
  };
  for (const field of fields) {
    const val = source[field];
    if (val === undefined || val === null) {
      row[field] = '';
    } else if (typeof val === 'object') {
      row[field] = Array.isArray(val) ? val.join('; ') : JSON.stringify(val);
    } else {
      row[field] = String(val).trim();
    }
  }
  return row;
}

/**
 * Extracts structured fields across multiple URLs distributed round-robin over `profileIds`.
 */
async function extractFromProfiles({
  db = null,
  browserManager,
  aiClient = null,
  profileIds,
  urls,
  fields,
  mode = 'dom'
} = {}) {
  if (!browserManager) {
    throw new Error('BrowserManager chưa được khởi tạo cho AI Extractor');
  }

  // Validate profileIds
  if (!Array.isArray(profileIds) || profileIds.length === 0) {
    throw new Error('Vui lòng chọn ít nhất 1 profile để trích xuất dữ liệu');
  }
  const cleanProfileIds = [];
  const seenProfiles = new Set();
  for (const rawId of profileIds) {
    const id = String(rawId ?? '').trim();
    if (id && !seenProfiles.has(id)) {
      seenProfiles.add(id);
      cleanProfileIds.push(id);
    }
  }
  if (cleanProfileIds.length === 0) {
    throw new Error('Danh sách profileIds không hợp lệ');
  }

  // Validate urls (strict http/https)
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error('Vui lòng nhập ít nhất 1 URL (http/https) để trích xuất');
  }
  const cleanUrls = [];
  for (const rawUrl of urls) {
    const valid = validateHttpUrl(rawUrl);
    if (!valid) {
      throw new Error(`URL không hợp lệ (chỉ chấp nhận http/https): ${rawUrl}`);
    }
    cleanUrls.push(valid);
  }

  // Validate fields
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('Vui lòng khai báo ít nhất 1 trường dữ liệu (fields) cần trích xuất');
  }
  const cleanFields = [];
  const seenFields = new Set();
  for (const rawField of fields) {
    const f = String(rawField ?? '').trim();
    if (f && !seenFields.has(f)) {
      seenFields.add(f);
      cleanFields.push(f);
    }
  }
  if (cleanFields.length === 0) {
    throw new Error('Danh sách trường dữ liệu (fields) không hợp lệ');
  }

  const requestedMode = String(mode || 'dom').toLowerCase() === 'vision' ? 'vision' : 'dom';
  const llmConfigured = Boolean(
    aiClient &&
    typeof aiClient.isConfigured === 'function' &&
    aiClient.isConfigured()
  );
  const canVision = Boolean(
    requestedMode === 'vision' &&
    llmConfigured &&
    typeof aiClient.generateVisionJson === 'function'
  );
  const canDomLlm = Boolean(
    llmConfigured &&
    typeof aiClient.generateJson === 'function'
  );

  // Assign URLs round-robin across profiles, preserving original index
  const assignmentsByProfile = new Map();
  for (let i = 0; i < cleanUrls.length; i += 1) {
    const profileId = cleanProfileIds[i % cleanProfileIds.length];
    if (!assignmentsByProfile.has(profileId)) {
      assignmentsByProfile.set(profileId, []);
    }
    assignmentsByProfile.get(profileId).push({ index: i, url: cleanUrls[i], profileId });
  }

  const orderedRows = new Array(cleanUrls.length).fill(null);
  const errors = [];
  let usedLlm = false;

  // Run each profile's queue sequentially to avoid tab collisions, while different profiles run in parallel
  const profileTasks = Array.from(assignmentsByProfile.entries()).map(async ([profileId, items]) => {
    let debuggingPort = null;
    try {
      const existing = typeof browserManager.getSession === 'function'
        ? browserManager.getSession(profileId)
        : null;
      if (existing && existing.debuggingPort) {
        debuggingPort = existing.debuggingPort;
      } else {
        const opened = await browserManager.openProfile(profileId);
        debuggingPort = opened.debuggingPort;
      }
    } catch (openErr) {
      for (const item of items) {
        errors.push({
          url: item.url,
          profileId,
          error: `Không mở được profile ${profileId}: ${openErr?.message || String(openErr)}`
        });
      }
      return;
    }

    for (const item of items) {
      try {
        await navigatePage(debuggingPort, item.url, { waitMs: 2500 });

        if (canVision) {
          const shot = await captureScreenshot(debuggingPort, { format: 'jpeg', quality: 80 });
          const systemPrompt =
            'You are a visual data extraction engine. Inspect the webpage screenshot and extract the requested fields. ' +
            'Return strictly a flat JSON object whose keys match the requested fields. Use empty string "" for missing values.';
          const userPrompt =
            `Source URL: ${item.url}\n` +
            `Extract these exact fields: ${JSON.stringify(cleanFields)}\n` +
            'Return JSON object only.';

          const raw = await aiClient.generateVisionJson({
            system: systemPrompt,
            systemPrompt,
            prompt: userPrompt,
            userPrompt,
            imageBase64: shot.base64,
            base64: shot.base64,
            mimeType: shot.mimeType,
            temperature: 0.1
          });

          usedLlm = true;
          const parsed = unwrapJsonResult(raw);
          orderedRows[item.index] = normalizeExtractedRow(parsed, cleanFields, {
            url: item.url,
            profileId
          });
        } else {
          const snapshot = await getPageSnapshot(debuggingPort, {
            maxTextChars: 6000,
            maxElements: 40
          });

          if (canDomLlm) {
            const systemPrompt =
              'You are a structured web data extraction engine. Extract the requested fields from the provided page snapshot. ' +
              'Return strictly a flat JSON object whose keys match the requested fields. Use empty string "" for missing values.';
            const userPrompt = JSON.stringify(
              {
                url: snapshot.url || item.url,
                title: snapshot.title || '',
                requestedFields: cleanFields,
                textExcerpt: snapshot.textExcerpt || ''
              },
              null,
              2
            );

            const raw = await aiClient.generateJson({
              system: systemPrompt,
              systemPrompt,
              prompt: userPrompt,
              userPrompt,
              temperature: 0.1
            });

            usedLlm = true;
            const parsed = unwrapJsonResult(raw);
            orderedRows[item.index] = normalizeExtractedRow(parsed, cleanFields, {
              url: item.url,
              profileId
            });
          } else {
            const offlineRow = extractOfflineMetadata(snapshot, cleanFields, item.url);
            offlineRow._url = item.url;
            offlineRow._profileId = profileId;
            orderedRows[item.index] = offlineRow;
          }
        }
      } catch (err) {
        errors.push({
          url: item.url,
          profileId,
          error: err?.message || String(err)
        });
      }
    }
  });

  await Promise.all(profileTasks);

  const rows = orderedRows.filter(Boolean);
  const csv = rowsToCsv(cleanFields, rows);

  return {
    ok: errors.length === 0 || rows.length > 0,
    mode: canVision ? 'vision' : 'dom',
    usedLlm,
    fields: cleanFields,
    rows,
    csv,
    errors
  };
}

module.exports = {
  EXTRACTOR_PRESETS,
  extractFromProfiles,
  rowsToCsv
};
