/**
 * VTN-Browser AI Profile Matrix Planner (`src/core/ai-matrix-planner.js`)
 * Designs anti-collision multi-profile hardware/locale/proxy matrices using
 * `HARDWARE_BLUEPRINTS` and existing DB inventory, with LLM planning + deterministic fallback.
 */

const {
  HARDWARE_BLUEPRINTS,
  getCompatibleMemoryOptions,
  extractHardwareSignature
} = require('./fingerprint-gen');
const { normalizeProxyConfig } = require('./proxy-tunnel');

const REGION_PRESETS = {
  US: {
    timeZones: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
    langs: 'en-US,en',
    acceptLang: 'en-US,en;q=0.9'
  },
  GB: {
    timeZones: ['Europe/London'],
    langs: 'en-GB,en',
    acceptLang: 'en-GB,en;q=0.9'
  },
  UK: {
    timeZones: ['Europe/London'],
    langs: 'en-GB,en',
    acceptLang: 'en-GB,en;q=0.9'
  },
  CA: {
    timeZones: ['America/Toronto', 'America/Vancouver', 'America/Edmonton'],
    langs: 'en-CA,en',
    acceptLang: 'en-CA,en;q=0.9'
  },
  AU: {
    timeZones: ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane'],
    langs: 'en-AU,en',
    acceptLang: 'en-AU,en;q=0.9'
  },
  DE: {
    timeZones: ['Europe/Berlin'],
    langs: 'de-DE,de,en-US,en',
    acceptLang: 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
  },
  FR: {
    timeZones: ['Europe/Paris'],
    langs: 'fr-FR,fr,en-US,en',
    acceptLang: 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
  },
  NL: {
    timeZones: ['Europe/Amsterdam'],
    langs: 'nl-NL,nl,en-US,en',
    acceptLang: 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7'
  },
  JP: {
    timeZones: ['Asia/Tokyo'],
    langs: 'ja-JP,ja,en-US,en',
    acceptLang: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
  },
  KR: {
    timeZones: ['Asia/Seoul'],
    langs: 'ko-KR,ko,en-US,en',
    acceptLang: 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
  },
  SG: {
    timeZones: ['Asia/Singapore'],
    langs: 'en-SG,en',
    acceptLang: 'en-SG,en;q=0.9'
  },
  VN: {
    timeZones: ['Asia/Ho_Chi_Minh'],
    langs: 'vi-VN,vi,en-US,en',
    acceptLang: 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
  }
};

const PLATFORM_START_URLS = {
  'Facebook / Meta': 'https://www.facebook.com/',
  TikTok: 'https://www.tiktok.com/',
  'Google Ads': 'https://ads.google.com/',
  'Amazon / eBay': 'https://www.amazon.com/',
  General: 'about:blank'
};

function parseProxiesText(proxiesText) {
  if (!proxiesText || typeof proxiesText !== 'string') return [];
  const lines = proxiesText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const parsed = [];
  for (const line of lines) {
    const norm = normalizeProxyConfig(line);
    if (norm && norm.host && norm.port) {
      parsed.push(norm);
    }
  }
  return parsed;
}

function formatProxyDisplay(proxyConfig) {
  if (!proxyConfig || proxyConfig.mode === 'direct' || !proxyConfig.host) {
    return 'Direct';
  }
  return `${proxyConfig.type || 'http'}://${proxyConfig.host}:${proxyConfig.port}`;
}

function resolveRegionPreset(region) {
  const code = String(region || 'US').trim().toUpperCase();
  return REGION_PRESETS[code] || REGION_PRESETS.US;
}

function computeBlueprintUsage(existingProfiles) {
  const counts = {};
  const usedCombos = new Set();
  for (const id of Object.keys(HARDWARE_BLUEPRINTS)) {
    counts[id] = 0;
  }
  for (const p of existingProfiles || []) {
    const sig = extractHardwareSignature(p);
    if (sig.blueprintId && counts[sig.blueprintId] !== undefined) {
      counts[sig.blueprintId]++;
    }
    if (sig.hwComboKey) usedCombos.add(sig.hwComboKey);
  }
  return { counts, usedCombos };
}

function pickLeastUsedBlueprintId(usageCounts, preferredOs = null) {
  const allIds = Object.keys(HARDWARE_BLUEPRINTS);
  const candidates = preferredOs
    ? allIds.filter((id) => HARDWARE_BLUEPRINTS[id].os.toLowerCase() === preferredOs.toLowerCase())
    : allIds;
  const pool = candidates.length > 0 ? candidates : allIds;

  let minCount = Infinity;
  for (const id of pool) {
    const c = usageCounts[id] || 0;
    if (c < minCount) minCount = c;
  }
  const leastUsed = pool.filter((id) => (usageCounts[id] || 0) === minCount);
  return leastUsed[0] || allIds[0];
}

function pickCompatibleHardware(bp, index, usedCombos) {
  for (let cIdx = 0; cIdx < bp.coresOptions.length; cIdx++) {
    const cores = bp.coresOptions[(index + cIdx) % bp.coresOptions.length];
    const memOpts = getCompatibleMemoryOptions(bp, cores);
    for (let mIdx = 0; mIdx < memOpts.length; mIdx++) {
      const mem = memOpts[(index + mIdx) % memOpts.length];
      for (let sIdx = 0; sIdx < bp.screens.length; sIdx++) {
        const scr = bp.screens[(index + sIdx) % bp.screens.length];
        const comboKey = `${bp.id}|${cores}|${mem}|${scr}`;
        if (!usedCombos.has(comboKey)) {
          usedCombos.add(comboKey);
          return {
            hardwareConcurrency: String(cores),
            deviceMemory: String(mem),
            screenSize: scr
          };
        }
      }
    }
  }
  const cores = bp.coresOptions[index % bp.coresOptions.length];
  const memOpts = getCompatibleMemoryOptions(bp, cores);
  const mem = memOpts[index % memOpts.length];
  const scr = bp.screens[index % bp.screens.length];
  return {
    hardwareConcurrency: String(cores),
    deviceMemory: String(mem),
    screenSize: scr
  };
}

function buildDeterministicPlan({ count, platform, region, goal, parsedProxies, existingProfiles }) {
  const { counts: usageCounts, usedCombos } = computeBlueprintUsage(existingProfiles);
  const preset = resolveRegionPreset(region);
  const regionCode = String(region || 'US').trim().toUpperCase();
  const groupName = platform === 'General' ? `Matrix ${regionCode}` : `${platform} (${regionCode})`;
  const defaultStartUrl = PLATFORM_START_URLS[platform] || 'about:blank';
  const shortPlatform = platform.split('/')[0].trim().replace(/\s+/g, '');

  const items = [];
  for (let i = 0; i < count; i++) {
    // Alternate OS diversity roughly 70% Windows / 30% macOS
    const preferredOs = (i % 3 === 2) ? 'macOS' : 'Windows';
    const bpId = pickLeastUsedBlueprintId(usageCounts, preferredOs);
    usageCounts[bpId] = (usageCounts[bpId] || 0) + 1;

    const bp = HARDWARE_BLUEPRINTS[bpId];
    const hw = pickCompatibleHardware(bp, i, usedCombos);
    const timeZone = preset.timeZones[i % preset.timeZones.length];
    const proxy = parsedProxies.length > 0 ? parsedProxies[i % parsedProxies.length] : { mode: 'direct' };
    const hasProxy = proxy && proxy.mode !== 'direct' && Boolean(proxy.host);
    const numStr = String(i + 1).padStart(2, '0');

    items.push({
      name: `${shortPlatform}-${regionCode}-${numStr}`,
      groupName,
      tags: [platform, regionCode, bp.os],
      notes: goal ? `Goal: ${goal}` : `Planned for ${platform} (${regionCode})`,
      blueprintId: bp.id,
      blueprintLabel: bp.label,
      os: bp.os,
      screenSize: hw.screenSize,
      hardwareConcurrency: hw.hardwareConcurrency,
      deviceMemory: hw.deviceMemory,
      timeZone,
      langs: preset.langs,
      acceptLang: preset.acceptLang,
      startUrl: defaultStartUrl,
      autoGeoIp: hasProxy,
      proxyConfig: proxy,
      proxyDisplay: formatProxyDisplay(proxy),
      rationale: `Anti-collision ${bp.os} slot (${bp.category}) with ${hw.screenSize.replace(',', 'x')} and ${timeZone}.`
    });
  }

  return items;
}

function validateAndNormalizePlannedItem(rawItem, index, {
  platform,
  region,
  goal,
  parsedProxies,
  usageCounts,
  usedCombos
}) {
  const preset = resolveRegionPreset(region);
  const regionCode = String(region || 'US').trim().toUpperCase();
  const defaultGroup = platform === 'General' ? `Matrix ${regionCode}` : `${platform} (${regionCode})`;
  const defaultStartUrl = PLATFORM_START_URLS[platform] || 'about:blank';
  const shortPlatform = platform.split('/')[0].trim().replace(/\s+/g, '');

  // Strictly validate blueprintId against HARDWARE_BLUEPRINTS
  let bpId = rawItem && typeof rawItem.blueprintId === 'string' && HARDWARE_BLUEPRINTS[rawItem.blueprintId]
    ? rawItem.blueprintId
    : pickLeastUsedBlueprintId(usageCounts);
  usageCounts[bpId] = (usageCounts[bpId] || 0) + 1;
  const bp = HARDWARE_BLUEPRINTS[bpId];

  // Validate hardware options against blueprint
  let coresNum = Number(rawItem?.hardwareConcurrency);
  if (!bp.coresOptions.includes(coresNum)) {
    coresNum = bp.coresOptions[index % bp.coresOptions.length];
  }
  const compatMem = getCompatibleMemoryOptions(bp, coresNum);
  let memNum = Number(rawItem?.deviceMemory);
  if (!compatMem.includes(memNum)) {
    memNum = compatMem[index % compatMem.length];
  }
  const rawScreen = String(rawItem?.screenSize || '').replace('x', ',').trim();
  const screenSize = bp.screens.includes(rawScreen)
    ? rawScreen
    : bp.screens[index % bp.screens.length];
  usedCombos.add(`${bp.id}|${coresNum}|${memNum}|${screenSize}`);

  const timeZone = (typeof rawItem?.timeZone === 'string' && rawItem.timeZone.includes('/'))
    ? rawItem.timeZone.trim()
    : preset.timeZones[index % preset.timeZones.length];

  const langs = (typeof rawItem?.langs === 'string' && rawItem.langs.trim())
    ? rawItem.langs.trim()
    : preset.langs;
  const acceptLang = (typeof rawItem?.acceptLang === 'string' && rawItem.acceptLang.trim())
    ? rawItem.acceptLang.trim()
    : preset.acceptLang;

  const proxy = parsedProxies.length > 0
    ? parsedProxies[index % parsedProxies.length]
    : { mode: 'direct' };
  const hasProxy = proxy && proxy.mode !== 'direct' && Boolean(proxy.host);

  const numStr = String(index + 1).padStart(2, '0');
  const name = (typeof rawItem?.name === 'string' && rawItem.name.trim())
    ? rawItem.name.trim().slice(0, 64)
    : `${shortPlatform}-${regionCode}-${numStr}`;

  const groupName = (typeof rawItem?.groupName === 'string' && rawItem.groupName.trim())
    ? rawItem.groupName.trim().slice(0, 64)
    : defaultGroup;

  const tags = Array.isArray(rawItem?.tags) && rawItem.tags.length > 0
    ? rawItem.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
    : [platform, regionCode, bp.os];

  const startUrl = (typeof rawItem?.startUrl === 'string' && /^https?:\/\//i.test(rawItem.startUrl.trim()))
    ? rawItem.startUrl.trim()
    : defaultStartUrl;

  return {
    name,
    groupName,
    tags,
    notes: (typeof rawItem?.notes === 'string' && rawItem.notes.trim())
      ? rawItem.notes.trim()
      : (goal ? `Goal: ${goal}` : `Planned for ${platform}`),
    blueprintId: bp.id,
    blueprintLabel: bp.label,
    os: bp.os,
    screenSize,
    hardwareConcurrency: String(coresNum),
    deviceMemory: String(memNum),
    timeZone,
    langs,
    acceptLang,
    startUrl,
    autoGeoIp: rawItem?.autoGeoIp !== undefined ? Boolean(rawItem.autoGeoIp) : hasProxy,
    proxyConfig: proxy,
    proxyDisplay: formatProxyDisplay(proxy),
    rationale: (typeof rawItem?.rationale === 'string' && rawItem.rationale.trim())
      ? rawItem.rationale.trim()
      : `${bp.label} · ${timeZone}`
  };
}

/**
 * Generates an anti-collision multi-profile matrix plan.
 *
 * @param {Object} params
 * @param {import('./db').ProfileDatabase} params.db
 * @param {import('./ai-client').AiClient} [params.aiClient]
 * @param {string} [params.goal='']
 * @param {number} [params.count=5]
 * @param {string} [params.platform='General']
 * @param {string} [params.region='US']
 * @param {string} [params.proxiesText='']
 */
async function generateMatrixPlan({
  db,
  aiClient = null,
  goal = '',
  count = 5,
  platform = 'General',
  region = 'US',
  proxiesText = ''
} = {}) {
  const safeCount = Math.max(1, Math.min(50, Math.round(Number(count) || 5)));
  const existingProfiles = db && typeof db.listProfiles === 'function' ? db.listProfiles() : [];
  const parsedProxies = parseProxiesText(proxiesText);
  const regionCode = String(region || 'US').trim().toUpperCase();
  const preset = resolveRegionPreset(regionCode);

  let usedLlm = false;
  let items = null;
  let summary = '';

  if (aiClient && typeof aiClient.isConfigured === 'function' && aiClient.isConfigured()) {
    try {
      const { counts: usageCounts, usedCombos } = computeBlueprintUsage(existingProfiles);
      const blueprintCatalog = Object.values(HARDWARE_BLUEPRINTS).map((bp) => ({
        id: bp.id,
        os: bp.os,
        category: bp.category,
        screens: bp.screens,
        cores: bp.coresOptions,
        usedCount: usageCounts[bp.id] || 0
      }));

      const llmRes = await aiClient.generateJson({
        systemPrompt: [
          'You are an anti-detect browser fleet architect.',
          'Design a diverse, anti-collision matrix of browser profiles using ONLY blueprintId values from the provided catalog.',
          'Prioritize blueprints with the lowest usedCount, mix Windows and macOS naturally, vary screens and regional timezones.',
          'Return JSON with shape: { "summary": "1 sentence plan overview", "items": [ { "name": "...", "groupName": "...", "tags": ["..."], "notes": "...", "blueprintId": "<exact id from catalog>", "screenSize": "1920,1080", "timeZone": "America/New_York", "langs": "en-US,en", "startUrl": "https://...", "rationale": "short reason" } ] }.'
        ].join(' '),
        prompt: JSON.stringify({
          goal: String(goal || '').slice(0, 400),
          count: safeCount,
          platform,
          region: regionCode,
          recommendedTimeZones: preset.timeZones,
          recommendedLangs: preset.langs,
          proxiesAvailable: parsedProxies.length,
          existingProfileCount: existingProfiles.length,
          blueprintCatalog
        }),
        temperature: 0.25
      });

      if (llmRes && Array.isArray(llmRes.items) && llmRes.items.length > 0) {
        const freshUsage = computeBlueprintUsage(existingProfiles);
        const normalized = [];
        for (let i = 0; i < safeCount; i++) {
          const candidate = llmRes.items[i] || {};
          normalized.push(validateAndNormalizePlannedItem(candidate, i, {
            platform,
            region: regionCode,
            goal,
            parsedProxies,
            usageCounts: freshUsage.counts,
            usedCombos: freshUsage.usedCombos
          }));
        }
        items = normalized;
        usedLlm = true;
        summary = (typeof llmRes.summary === 'string' && llmRes.summary.trim())
          ? llmRes.summary.trim()
          : `AI planned ${safeCount} anti-collision profiles for ${platform} (${regionCode}).`;
      }
    } catch {
      usedLlm = false;
    }
  }

  if (!items) {
    items = buildDeterministicPlan({
      count: safeCount,
      platform,
      region: regionCode,
      goal,
      parsedProxies,
      existingProfiles
    });
    summary = `Generated ${safeCount} anti-collision profiles across ${new Set(items.map((x) => x.blueprintId)).size} distinct hardware blueprints for ${platform} (${regionCode}).`;
  }

  return {
    goal: String(goal || ''),
    platform,
    region: regionCode,
    count: items.length,
    usedLlm,
    parsedProxiesCount: parsedProxies.length,
    summary,
    items
  };
}

/**
 * Materializes a planned matrix into SQLite via `db.createProfile({ ..., ensureUnique: true })`.
 *
 * @param {import('./db').ProfileDatabase} db
 * @param {Array<Object>} items
 * @returns {{ createdCount: number, profiles: Array<Object> }}
 */
function applyMatrixPlan(db, items = []) {
  if (!db) throw new Error('Database instance is required for applyMatrixPlan.');
  if (!Array.isArray(items) || items.length === 0) {
    return { createdCount: 0, profiles: [] };
  }

  const created = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const blueprintId = item.blueprintId && HARDWARE_BLUEPRINTS[item.blueprintId]
      ? item.blueprintId
      : undefined;

    const fingerprintOverrides = {};
    if (blueprintId) fingerprintOverrides.blueprintId = blueprintId;
    if (item.screenSize) fingerprintOverrides.screenSize = String(item.screenSize).replace('x', ',');
    if (item.hardwareConcurrency) fingerprintOverrides.hardwareConcurrency = String(item.hardwareConcurrency);
    if (item.deviceMemory) fingerprintOverrides.deviceMemory = String(item.deviceMemory);
    if (item.timeZone) fingerprintOverrides.timeZone = String(item.timeZone);
    if (item.langs) fingerprintOverrides.langs = String(item.langs);
    if (item.acceptLang) fingerprintOverrides.acceptLang = String(item.acceptLang);

    const normProxy = normalizeProxyConfig(item.proxyConfig);
    const proxyConfig = normProxy || { mode: 'direct' };

    const profile = db.createProfile({
      name: item.name || undefined,
      groupName: item.groupName || 'Default',
      tags: Array.isArray(item.tags) ? item.tags : [],
      notes: item.notes || '',
      proxyConfig,
      autoGeoIp: item.autoGeoIp !== undefined ? Boolean(item.autoGeoIp) : Boolean(normProxy),
      startUrl: item.startUrl || 'about:blank',
      fingerprintOverrides,
      ensureUnique: true
    });

    if (profile) created.push(profile);
  }

  return {
    createdCount: created.length,
    profiles: created
  };
}

module.exports = {
  generateMatrixPlan,
  applyMatrixPlan,
  parseProxiesText
};
