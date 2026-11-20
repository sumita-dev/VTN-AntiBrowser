/**
 * VTN-Browser AI Fingerprint & Stealth Auditor (`src/core/ai-auditor.js`)
 * Runs deterministic anti-detect checks (static config, live CDP probe when running,
 * Proxy GeoIP alignment, cross-profile collision) and optionally enriches with
 * LLM platform-specific risk analysis.
 */

const { HARDWARE_BLUEPRINTS, extractHardwareSignature } = require('./fingerprint-gen');
const { normalizeProxyConfig, checkProxyConnectivity } = require('./proxy-tunnel');
const { probeRunningProfile } = require('./cdp-probe');

const SEVERITY_WEIGHTS = {
  critical: 25,
  high: 15,
  medium: 8,
  low: 3,
  info: 0
};

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);

const MAC_EXCLUSIVE_SCREENS = new Set([
  '1728,1117', '1512,982', '1470,956', '1440,900', '1792,1120',
  '1728x1117', '1512x982', '1470x956', '1440x900', '1792x1120'
]);

const STRICT_PLATFORMS = new Set([
  'Facebook / Meta',
  'TikTok',
  'Google Ads',
  'Amazon / eBay'
]);

function computeGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}

function buildAcceptLanguageHeader(langsInput) {
  const list = Array.isArray(langsInput)
    ? langsInput.map((s) => String(s).trim()).filter(Boolean)
    : String(langsInput || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return 'en-US,en;q=0.9';
  return list.map((lang, idx) => {
    if (idx === 0) return lang;
    const q = Math.max(0.1, Number((1 - idx * 0.1).toFixed(1)));
    return `${lang};q=${q}`;
  }).join(',');
}

function primaryLangCode(langsStr) {
  const first = String(langsStr || '').split(',')[0].trim();
  return first.split('-')[0].toLowerCase();
}

function normalizeScreenKey(scr) {
  return String(scr || '').trim().replace('x', ',');
}

function computeScoreFromFindings(findings) {
  let score = 100;
  for (const f of findings) {
    const sev = VALID_SEVERITIES.has(f.severity) ? f.severity : 'info';
    score -= SEVERITY_WEIGHTS[sev] || 0;
  }
  return Math.max(0, Math.min(100, score));
}

function makeFinding({ code, severity = 'medium', category = 'fingerprint', title, detail, fixHint = '', source = 'deterministic' }) {
  return {
    code,
    severity: VALID_SEVERITIES.has(severity) ? severity : 'medium',
    category,
    title,
    detail,
    fixHint,
    source
  };
}

/**
 * Runs a comprehensive stealth & consistency audit on a profile.
 *
 * @param {Object} params
 * @param {import('./db').ProfileDatabase} params.db
 * @param {import('./browser-manager').BrowserManager} [params.browserManager]
 * @param {import('./ai-client').AiClient} [params.aiClient]
 * @param {string} params.profileId
 * @param {string} [params.platform='General']
 * @param {boolean} [params.checkProxy=true]
 */
async function auditProfile({
  db,
  browserManager = null,
  aiClient = null,
  profileId,
  platform = 'General',
  checkProxy = true
} = {}) {
  if (!db) throw new Error('Database instance is required for auditProfile.');
  const profile = db.getProfile(String(profileId));
  if (!profile) {
    throw new Error(`Profile not found: ${profileId}`);
  }

  const fp = profile.fingerprint || {};
  const sw = fp.switches || {};
  const st = fp.staticConfig || {};
  const dyn = fp.dynamicConfig || {};
  const wgl = fp.webglFp || {};
  const bp = fp.blueprintId && HARDWARE_BLUEPRINTS[fp.blueprintId]
    ? HARDWARE_BLUEPRINTS[fp.blueprintId]
    : null;

  const findings = [];
  const suggestedPatch = {
    fingerprintPatch: {}
  };

  // ============================================================================
  // 1. Live CDP Probe (if browser profile is currently open)
  // ============================================================================
  let probe = null;
  let probeUsed = false;
  if (browserManager && typeof browserManager.getSession === 'function') {
    const sess = browserManager.getSession(profile.id);
    if (sess && sess.debuggingPort) {
      try {
        probe = await probeRunningProfile(sess.debuggingPort, 5000);
        probeUsed = Boolean(probe);
      } catch (err) {
        findings.push(makeFinding({
          code: 'CDP_PROBE_FAILED',
          severity: 'low',
          category: 'runtime',
          title: 'Live CDP probe unavailable',
          detail: `Profile is running on port ${sess.debuggingPort} but live probe failed: ${err.message}`,
          fixHint: 'Ensure a normal page tab is open and HideDebugPanel is disabled.'
        }));
      }
    }
  }

  // ============================================================================
  // 2. WebDriver & Automation Flags
  // ============================================================================
  if (st.AutomationControlled !== '0') {
    findings.push(makeFinding({
      code: 'WEBDRIVER_CONFIG_EXPOSED',
      severity: 'critical',
      category: 'stealth',
      title: 'AutomationControlled flag is not disabled',
      detail: `staticConfig.AutomationControlled is "${st.AutomationControlled ?? 'unset'}" instead of "0".`,
      fixHint: 'Relaunch profile so config-builder heals AutomationControlled to "0".'
    }));
  }

  if (probe) {
    if (probe.webdriver === true) {
      findings.push(makeFinding({
        code: 'WEBDRIVER_LIVE_TRUE',
        severity: 'critical',
        category: 'stealth',
        title: 'navigator.webdriver is true in live browser',
        detail: 'Anti-bot scripts can immediately detect automation when navigator.webdriver === true.',
        fixHint: 'Verify C++ AutomationControlled=0 hook in StaticConfig.enc.'
      }));
    }

    // [native code] Anti-Tamper Prototype Checks
    const at = probe.antiTamper || {};
    const toDataUrlStr = String(at.toDataURLToString || '');
    const getParamStr = String(at.getParameterToString || '');
    if (toDataUrlStr && !toDataUrlStr.includes('[native code]')) {
      findings.push(makeFinding({
        code: 'ANTITAMPER_CANVAS_NON_NATIVE',
        severity: 'high',
        category: 'stealth',
        title: 'Canvas toDataURL prototype tampered (missing [native code])',
        detail: `HTMLCanvasElement.prototype.toDataURL.toString() returned "${toDataUrlStr.slice(0, 80)}".`,
        fixHint: 'Disable JS-level fingerprint spoofing extensions; rely on native C++ hooks.'
      }));
    }
    if (getParamStr && !getParamStr.includes('[native code]')) {
      findings.push(makeFinding({
        code: 'ANTITAMPER_WEBGL_NON_NATIVE',
        severity: 'high',
        category: 'stealth',
        title: 'WebGL getParameter prototype tampered (missing [native code])',
        detail: `WebGLRenderingContext.prototype.getParameter.toString() returned "${getParamStr.slice(0, 80)}".`,
        fixHint: 'Disable JS-level WebGL spoofing extensions; rely on native C++ hooks.'
      }));
    }
    if (typeof at.ownNavPropsCount === 'number' && at.ownNavPropsCount > 0) {
      findings.push(makeFinding({
        code: 'ANTITAMPER_NAVIGATOR_OWN_PROPS',
        severity: 'medium',
        category: 'stealth',
        title: 'Unexpected own properties defined on navigator instance',
        detail: `Object.getOwnPropertyNames(navigator).length = ${at.ownNavPropsCount} (expected 0 on clean Chromium).`,
        fixHint: 'Avoid JS Object.defineProperty patches on navigator.'
      }));
    }
  }

  // ============================================================================
  // 3. Canvas & WebGL Consistency Checks
  // ============================================================================
  const canvasMarkNum = parseInt(sw.CanvasMark, 10);
  if (isNaN(canvasMarkNum) || canvasMarkNum < 1000) {
    findings.push(makeFinding({
      code: 'CANVAS_MARK_BELOW_THRESHOLD',
      severity: 'high',
      category: 'fingerprint',
      title: 'CanvasMark below C++ hook activation threshold (< 1000)',
      detail: `Configured CanvasMark is "${sw.CanvasMark ?? 'unset'}". Values < 1000 bypass C++ canvas noise.`,
      fixHint: 'Regenerate fingerprint or set CanvasMark >= 100000.'
    }));
  }

  const platformStr = String(sw.Platform || '');
  const rendererStr = String(wgl.UNMASKED_RENDERER_WEBGL || '');
  if (!rendererStr) {
    findings.push(makeFinding({
      code: 'WEBGL_RENDERER_MISSING',
      severity: 'high',
      category: 'fingerprint',
      title: 'WebGL UNMASKED_RENDERER_WEBGL is empty',
      detail: 'Missing GPU renderer string creates a high-entropy anomaly on WebGL checks.',
      fixHint: 'Assign a valid hardware blueprint.'
    }));
  } else {
    if (/swiftshader|llvmpipe|mesa offscreen/i.test(rendererStr)) {
      findings.push(makeFinding({
        code: 'WEBGL_SOFTWARE_RENDERER',
        severity: 'critical',
        category: 'fingerprint',
        title: 'Software WebGL renderer detected (headless/VM signal)',
        detail: `Renderer "${rendererStr}" is strongly associated with headless automation or VMs.`,
        fixHint: 'Switch to a real hardware GPU blueprint (NVIDIA/AMD/Intel/Apple).'
      }));
    }
    if (platformStr === 'MacIntel' && /Direct3D11|D3D11/i.test(rendererStr)) {
      findings.push(makeFinding({
        code: 'WEBGL_OS_MISMATCH_MAC',
        severity: 'critical',
        category: 'fingerprint',
        title: 'OS/GPU mismatch: MacIntel using Direct3D11 renderer',
        detail: `Platform is MacIntel but WebGL renderer is "${rendererStr}".`,
        fixHint: 'Use an Apple Metal macOS blueprint.'
      }));
    } else if (platformStr === 'Win32' && /Metal Renderer|Apple M/i.test(rendererStr)) {
      findings.push(makeFinding({
        code: 'WEBGL_OS_MISMATCH_WIN',
        severity: 'critical',
        category: 'fingerprint',
        title: 'OS/GPU mismatch: Win32 using Apple Metal renderer',
        detail: `Platform is Win32 but WebGL renderer is "${rendererStr}".`,
        fixHint: 'Use a Windows Direct3D11 blueprint.'
      }));
    }
  }

  if (probe && probe.webgl) {
    if (!probe.canvasHash) {
      findings.push(makeFinding({
        code: 'LIVE_CANVAS_EMPTY',
        severity: 'high',
        category: 'fingerprint',
        title: 'Live Canvas readback failed or returned empty hash',
        detail: 'Canvas 2D context could not produce a valid hash in live browser.',
        fixHint: 'Check GPU/Canvas hook configuration.'
      }));
    }
    if (probe.webgl.unmaskedRenderer && rendererStr && probe.webgl.unmaskedRenderer !== rendererStr) {
      findings.push(makeFinding({
        code: 'LIVE_WEBGL_DRIFT',
        severity: 'high',
        category: 'fingerprint',
        title: 'Live WebGL renderer differs from configured blueprint',
        detail: `Live: "${probe.webgl.unmaskedRenderer}" vs Configured: "${rendererStr}".`,
        fixHint: 'Restart profile to reload WebGLFP.enc.'
      }));
    }
  }

  // ============================================================================
  // 4. Screen / OS / UA Metadata Hardware Coherence
  // ============================================================================
  const screenKey = normalizeScreenKey(sw.ScreenSize);
  if (!screenKey) {
    findings.push(makeFinding({
      code: 'SCREEN_SIZE_MISSING',
      severity: 'medium',
      category: 'hardware',
      title: 'ScreenSize is not configured',
      detail: 'Profile has no explicit screen resolution configured.',
      fixHint: 'Assign a standard resolution matching the hardware blueprint.'
    }));
  } else if (platformStr === 'Win32' && MAC_EXCLUSIVE_SCREENS.has(screenKey)) {
    findings.push(makeFinding({
      code: 'SCREEN_OS_MISMATCH',
      severity: 'high',
      category: 'hardware',
      title: 'Apple Retina screen resolution configured on Windows profile',
      detail: `ScreenSize "${screenKey}" is exclusive to MacBook displays but Platform is Win32.`,
      fixHint: 'Use a standard 16:9 / 16:10 Windows resolution (e.g. 1920,1080 or 2560,1440).'
    }));
  }

  const uaMeta = st.UserAgentMetadata || {};
  if (platformStr === 'MacIntel' && /Apple M/i.test(rendererStr) && uaMeta.architecture && uaMeta.architecture !== 'arm') {
    findings.push(makeFinding({
      code: 'UA_ARCH_MISMATCH_ARM',
      severity: 'high',
      category: 'hardware',
      title: 'Apple Silicon GPU paired with non-ARM UserAgentMetadata',
      detail: `GPU is "${rendererStr}" but UserAgentMetadata.architecture is "${uaMeta.architecture}".`,
      fixHint: 'Set UserAgentMetadata.architecture to "arm".'
    }));
  } else if (platformStr === 'Win32' && uaMeta.architecture && uaMeta.architecture !== 'x86') {
    findings.push(makeFinding({
      code: 'UA_ARCH_MISMATCH_X86',
      severity: 'high',
      category: 'hardware',
      title: 'Windows x64 profile paired with non-x86 UserAgentMetadata',
      detail: `Platform is Win32 but UserAgentMetadata.architecture is "${uaMeta.architecture}".`,
      fixHint: 'Set UserAgentMetadata.architecture to "x86".'
    }));
  }

  if (bp) {
    const cores = parseInt(sw.HardwareConcurrency, 10);
    const ram = parseInt(sw.DeviceMemory, 10);
    if (!isNaN(cores) && !bp.coresOptions.includes(cores)) {
      findings.push(makeFinding({
        code: 'HW_CORES_ANOMALY',
        severity: 'low',
        category: 'hardware',
        title: 'CPU core count unusual for selected blueprint',
        detail: `${cores} cores is outside blueprint "${bp.id}" typical options [${bp.coresOptions.join(', ')}].`,
        fixHint: 'Align HardwareConcurrency with the selected blueprint.'
      }));
    }
    if (!isNaN(ram) && !bp.memoryOptions.includes(ram)) {
      findings.push(makeFinding({
        code: 'HW_RAM_ANOMALY',
        severity: 'low',
        category: 'hardware',
        title: 'DeviceMemory unusual for selected blueprint',
        detail: `${ram}GB RAM is outside blueprint "${bp.id}" typical options [${bp.memoryOptions.join(', ')}].`,
        fixHint: 'Align DeviceMemory with the selected blueprint.'
      }));
    }
  }

  // ============================================================================
  // 5. Proxy GeoIP vs Timezone / Language / AutoGeoIp Checks
  // ============================================================================
  const normProxy = normalizeProxyConfig(profile.proxyConfig);
  let proxyInfo = {
    mode: normProxy ? normProxy.type : 'direct',
    checked: false,
    ok: null,
    ip: null,
    countryCode: null,
    country: null,
    city: null,
    timeZone: null,
    langs: null,
    latencyMs: null,
    error: null
  };

  if (!normProxy && STRICT_PLATFORMS.has(platform)) {
    findings.push(makeFinding({
      code: 'PROXY_DIRECT_ON_STRICT_PLATFORM',
      severity: 'medium',
      category: 'network',
      title: `No proxy configured for ${platform}`,
      detail: `Profile uses direct host IP. Multi-accounting on ${platform} without isolated residential/ISP proxies risks IP linkage.`,
      fixHint: 'Assign a dedicated residential or ISP proxy for this profile.'
    }));
  }

  if (checkProxy) {
    try {
      const geo = await checkProxyConnectivity(profile.proxyConfig);
      proxyInfo = {
        mode: geo.mode || (normProxy ? normProxy.type : 'direct'),
        checked: true,
        ok: Boolean(geo.ok),
        ip: geo.ip || null,
        countryCode: geo.countryCode || null,
        country: geo.country || null,
        city: geo.city || null,
        timeZone: geo.timeZone || null,
        langs: geo.langs || null,
        latencyMs: geo.latencyMs || null,
        error: geo.error || null
      };

      if (!geo.ok) {
        findings.push(makeFinding({
          code: normProxy ? 'PROXY_UNREACHABLE' : 'GEOIP_LOOKUP_FAILED',
          severity: normProxy ? 'high' : 'low',
          category: 'network',
          title: normProxy ? 'Configured proxy failed connectivity check' : 'Direct GeoIP lookup failed',
          detail: geo.error || 'Could not resolve exit IP / GeoIP metadata.',
          fixHint: normProxy ? 'Verify proxy host, port, and credentials.' : 'Check internet connection.'
        }));
      } else {
        const profileTz = (probe && probe.timeZone) || sw.TimeZone || dyn.TimeZone || '';
        const profileLangs = (probe && Array.isArray(probe.languages) && probe.languages.length > 0)
          ? probe.languages.join(',')
          : (sw.Langs || '');

        if (geo.timeZone && profileTz && geo.timeZone !== profileTz) {
          findings.push(makeFinding({
            code: 'GEOIP_TIMEZONE_MISMATCH',
            severity: profile.autoGeoIp ? 'medium' : 'high',
            category: 'geoip',
            title: 'Timezone does not match exit IP GeoIP',
            detail: `Exit IP (${geo.countryCode || '??'}) timezone is "${geo.timeZone}" but profile timezone is "${profileTz}".`,
            fixHint: `Set timezone to "${geo.timeZone}" and enable Auto GeoIP.`
          }));
          suggestedPatch.fingerprintPatch.timezone = geo.timeZone;
          suggestedPatch.autoGeoIp = true;
        }

        if (geo.langs && profileLangs && primaryLangCode(geo.langs) !== primaryLangCode(profileLangs)) {
          const primaryLang = geo.langs.split(',')[0].trim();
          findings.push(makeFinding({
            code: 'GEOIP_LANGUAGE_MISMATCH',
            severity: 'medium',
            category: 'geoip',
            title: 'Browser language does not match exit IP country',
            detail: `Exit IP (${geo.countryCode || '??'}) expects "${geo.langs}" but profile uses "${profileLangs}".`,
            fixHint: `Align profile languages to "${geo.langs}".`
          }));
          suggestedPatch.fingerprintPatch.language = primaryLang;
          suggestedPatch.fingerprintPatch.languages = geo.langs;
        }

        if (normProxy && !profile.autoGeoIp) {
          findings.push(makeFinding({
            code: 'AUTOGEOIP_DISABLED_WITH_PROXY',
            severity: 'low',
            category: 'geoip',
            title: 'Auto GeoIP synchronization is disabled on a proxied profile',
            detail: 'Enabling Auto GeoIP ensures TimeZone, WebRTC PublicIP, and Geoposition stay synced if the proxy IP rotates.',
            fixHint: 'Enable autoGeoIp on this profile.'
          }));
          suggestedPatch.autoGeoIp = true;
        }
      }
    } catch (err) {
      proxyInfo.checked = true;
      proxyInfo.ok = false;
      proxyInfo.error = err.message;
    }
  }

  // ============================================================================
  // 6. Cross-Profile Collision Check
  // ============================================================================
  try {
    const allProfiles = db.listProfiles();
    const mySig = extractHardwareSignature(profile);
    let canvasCollisions = 0;
    let macCollisions = 0;
    for (const other of allProfiles) {
      if (other.id === profile.id) continue;
      const otherSig = extractHardwareSignature(other);
      if (mySig.canvasMark && otherSig.canvasMark === mySig.canvasMark) canvasCollisions++;
      if (mySig.macAddress && otherSig.macAddress === mySig.macAddress) macCollisions++;
    }
    if (canvasCollisions > 0 || macCollisions > 0) {
      findings.push(makeFinding({
        code: 'CROSS_PROFILE_COLLISION',
        severity: 'high',
        category: 'isolation',
        title: 'Fingerprint identifier collision with another local profile',
        detail: `Detected ${canvasCollisions} CanvasMark collision(s) and ${macCollisions} MAC address collision(s) across local profiles.`,
        fixHint: 'Regenerate fingerprint with uniqueness enforcement.'
      }));
    }
  } catch {
    // Non-fatal
  }

  // Clean up empty suggestedPatch.fingerprintPatch
  if (Object.keys(suggestedPatch.fingerprintPatch).length === 0) {
    delete suggestedPatch.fingerprintPatch;
  }
  const hasSuggestedPatch = Object.keys(suggestedPatch).length > 0;

  let score = computeScoreFromFindings(findings);
  let grade = computeGrade(score);
  let usedLlm = false;
  let summary = findings.length === 0
    ? `Profile "${profile.name}" passed all deterministic anti-detect checks for ${platform} (Score ${score}/100, Grade ${grade}).`
    : `Found ${findings.length} deterministic issue(s) for ${platform} (Score ${score}/100, Grade ${grade}).`;

  // ============================================================================
  // 7. Optional LLM Platform-Specific Risk Analysis
  // ============================================================================
  if (aiClient && typeof aiClient.isConfigured === 'function' && aiClient.isConfigured()) {
    try {
      const sanitizedContext = {
        platform,
        profileName: profile.name,
        os: fp.os || null,
        blueprintId: fp.blueprintId || null,
        platformSwitch: sw.Platform || null,
        cores: sw.HardwareConcurrency || null,
        memoryGb: sw.DeviceMemory || null,
        screenSize: sw.ScreenSize || null,
        timeZone: sw.TimeZone || dyn.TimeZone || null,
        langs: sw.Langs || null,
        webglRenderer: wgl.UNMASKED_RENDERER_WEBGL || null,
        autoGeoIp: Boolean(profile.autoGeoIp),
        proxyMode: proxyInfo.mode,
        proxyGeo: proxyInfo.ok
          ? { countryCode: proxyInfo.countryCode, timeZone: proxyInfo.timeZone, langs: proxyInfo.langs }
          : null,
        probeUsed,
        deterministicFindings: findings.map((f) => ({
          code: f.code,
          severity: f.severity,
          title: f.title,
          detail: f.detail
        }))
      };

      const llmResult = await aiClient.generateJson({
        systemPrompt: [
          'You are an anti-detect browser security & fingerprint auditor.',
          'Analyze the profile telemetry for platform-specific ban/checkpoint risks.',
          'Return JSON with shape: { "summary": "concise 1-2 sentence assessment", "additionalFindings": [ { "code": "UPPER_SNAKE", "severity": "high|medium|low|info", "category": "platform|stealth|network|fingerprint", "title": "...", "detail": "...", "fixHint": "..." } ] }.',
          'Do not repeat deterministicFindings already provided. Return at most 3 high-signal platform-specific findings.'
        ].join(' '),
        prompt: JSON.stringify(sanitizedContext),
        temperature: 0.15
      });

      if (llmResult && typeof llmResult === 'object') {
        usedLlm = true;
        if (typeof llmResult.summary === 'string' && llmResult.summary.trim()) {
          summary = llmResult.summary.trim();
        }
        if (Array.isArray(llmResult.additionalFindings)) {
          const existingCodes = new Set(findings.map((f) => f.code));
          const existingTitles = new Set(findings.map((f) => f.title.toLowerCase()));
          for (const raw of llmResult.additionalFindings.slice(0, 3)) {
            if (!raw || !raw.title) continue;
            const code = String(raw.code || `AI_${findings.length + 1}`).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
            const title = String(raw.title).trim();
            if (existingCodes.has(code) || existingTitles.has(title.toLowerCase())) continue;
            // Cap LLM-only findings at 'high' so deterministic checks stay authoritative
            const rawSev = String(raw.severity || 'low').toLowerCase();
            const safeSev = rawSev === 'critical' ? 'high' : (VALID_SEVERITIES.has(rawSev) ? rawSev : 'low');
            findings.push(makeFinding({
              code,
              severity: safeSev,
              category: String(raw.category || 'platform'),
              title,
              detail: String(raw.detail || '').trim(),
              fixHint: String(raw.fixHint || '').trim(),
              source: 'llm'
            }));
            existingCodes.add(code);
            existingTitles.add(title.toLowerCase());
          }
          score = computeScoreFromFindings(findings);
          grade = computeGrade(score);
        }
      }
    } catch {
      // Gracefully keep deterministic audit result if LLM call fails
      usedLlm = false;
    }
  }

  const report = {
    profileId: profile.id,
    profileName: profile.name,
    platform,
    score,
    grade,
    usedLlm,
    probeUsed,
    proxyInfo,
    findings,
    suggestedPatch: hasSuggestedPatch ? suggestedPatch : null,
    summary
  };

  try {
    db.saveAuditLog({
      profileId: profile.id,
      platform,
      score,
      report
    });
  } catch {
    // Do not fail audit response if log write fails
  }

  return report;
}

/**
 * Applies ONLY safe whitelisted audit fix fields to a profile:
 * - `autoGeoIp` (boolean)
 * - `fingerprintPatch.timezone` (string)
 * - `fingerprintPatch.language` (string)
 * - `fingerprintPatch.languages` (string or string[])
 *
 * @param {import('./db').ProfileDatabase} db
 * @param {string} profileId
 * @param {Object} suggestedPatch
 */
function applyAuditFix(db, profileId, suggestedPatch = {}) {
  if (!db) throw new Error('Database instance is required for applyAuditFix.');
  const profile = db.getProfile(String(profileId));
  if (!profile) {
    throw new Error(`Profile not found: ${profileId}`);
  }
  if (!suggestedPatch || typeof suggestedPatch !== 'object') {
    return { ok: true, profile, appliedFields: [] };
  }

  const appliedFields = [];
  const updatePayload = {};

  if (typeof suggestedPatch.autoGeoIp === 'boolean') {
    updatePayload.autoGeoIp = suggestedPatch.autoGeoIp;
    appliedFields.push('autoGeoIp');
  }

  const fpPatch = suggestedPatch.fingerprintPatch;
  if (fpPatch && typeof fpPatch === 'object') {
    const clonedFp = JSON.parse(JSON.stringify(profile.fingerprint || {}));
    if (!clonedFp.switches) clonedFp.switches = {};
    if (!clonedFp.dynamicConfig) clonedFp.dynamicConfig = {};
    let fpChanged = false;

    if (typeof fpPatch.timezone === 'string' && fpPatch.timezone.trim()) {
      const tz = fpPatch.timezone.trim();
      clonedFp.switches.TimeZone = tz;
      clonedFp.dynamicConfig.TimeZone = tz;
      appliedFields.push('fingerprintPatch.timezone');
      fpChanged = true;
    }

    let resolvedLangs = null;
    if (Array.isArray(fpPatch.languages) && fpPatch.languages.length > 0) {
      resolvedLangs = fpPatch.languages.map((s) => String(s).trim()).filter(Boolean).join(',');
      appliedFields.push('fingerprintPatch.languages');
    } else if (typeof fpPatch.languages === 'string' && fpPatch.languages.trim()) {
      resolvedLangs = fpPatch.languages.trim();
      appliedFields.push('fingerprintPatch.languages');
    } else if (typeof fpPatch.language === 'string' && fpPatch.language.trim()) {
      const primary = fpPatch.language.trim();
      const base = primary.split('-')[0];
      resolvedLangs = base && base !== primary ? `${primary},${base}` : primary;
      appliedFields.push('fingerprintPatch.language');
    }

    if (resolvedLangs) {
      clonedFp.switches.Langs = resolvedLangs;
      clonedFp.switches.AcceptLang = buildAcceptLanguageHeader(resolvedLangs);
      fpChanged = true;
    }

    if (fpChanged) {
      updatePayload.fingerprint = clonedFp;
    }
  }

  if (appliedFields.length === 0) {
    return { ok: true, profile, appliedFields: [] };
  }

  const updated = db.updateProfile(profile.id, updatePayload);
  return {
    ok: true,
    profile: updated,
    appliedFields
  };
}

module.exports = {
  auditProfile,
  applyAuditFix
};
