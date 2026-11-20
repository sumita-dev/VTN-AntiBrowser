/**
 * VTN Anti-Browser Antidetect MCP Server (`src/core/mcp-server.js`)
 * Zero-dependency Model Context Protocol (MCP) Streamable HTTP server (spec 2025-03-26)
 * designed for Antigravity 2.0 and any MCP-compatible AI Agent.
 *
 * Exposes 28 tools for profile lifecycle & CRUD, Cloudflare R2 cloud sync, C++ native
 * fingerprint probing, proxy checking, full CDP browser automation (tabs, wait, keyboard,
 * select, cookies, navigate, snapshot, click, type, scroll, screenshot, JS eval), and
 * AI Studio operations (stealth audit, account warming, anti-collision matrix planner).
 */

const crypto = require('crypto');
const { HARDWARE_BLUEPRINTS } = require('./fingerprint-gen');
const { checkProxyConnectivity, normalizeProxyConfig } = require('./proxy-tunnel');
const { probeRunningProfile } = require('./cdp-probe');
const {
  listPages,
  navigatePage,
  getPageSnapshot,
  clickElement,
  typeText,
  scrollPage,
  evaluateScript,
  captureScreenshot,
  newTab,
  closeTab,
  waitForSelector,
  pressKey,
  selectOption,
  getCookies,
  setCookies
} = require('./cdp-controller');
const { AiClient } = require('./ai-client');
const { auditProfile, applyAuditFix } = require('./ai-auditor');
const { AiAccountWarmer, WARMING_PRESETS } = require('./ai-warmer');
const { generateMatrixPlan, applyMatrixPlan } = require('./ai-matrix-planner');

const SUPPORTED_PROTOCOL_VERSION = '2025-03-26';

const MCP_TOOLS = [
  {
    name: 'vtn_list_profiles',
    description: 'List all VTN Anti-Browser profiles with their group, proxy mode, hardware blueprint, and live running status (CDP port if open).',
    inputSchema: {
      type: 'object',
      properties: {
        groupName: { type: 'string', description: 'Optional filter by profile group name.' },
        runningOnly: { type: 'boolean', description: 'If true, return only currently running profiles.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'vtn_list_blueprints',
    description: 'List the 19 built-in Hardware Blueprints (Windows/macOS, NVIDIA/Apple Silicon/AMD/Intel) available for profile creation.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'vtn_create_unique_profile',
    description: 'Create a new antidetect browser profile with guaranteed 0% fingerprint collision (Canvas, WebGL, Audio, MAC, DeviceName).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the new profile.' },
        groupName: { type: 'string', description: 'Group name (default: "Default").' },
        blueprintId: { type: 'string', description: 'Optional Hardware Blueprint ID from vtn_list_blueprints.' },
        proxy: { type: 'string', description: 'Optional proxy URL, e.g. http://user:pass@host:port or socks5://host:port.' },
        autoGeoIp: { type: 'boolean', description: 'Automatically sync timezone, language, and geolocation from proxy IP.' },
        startUrl: { type: 'string', description: 'Initial URL to open when launching this profile.' },
        notes: { type: 'string', description: 'Optional notes for this profile.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'vtn_open_profile',
    description: 'Launch an antidetect Chromium 151 browser window for the specified profileId and return its CDP endpoints.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target profile ID (from vtn_list_profiles).' },
        headless: { type: 'boolean', description: 'Launch in headless mode (default: false).' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_close_profile',
    description: 'Close a running profile browser process cleanly (triggers Cloudflare R2 cloud sync and lock release if enabled).',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID to close.' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_probe_fingerprint',
    description: 'Run the live CDP Fingerprint Probe on a running profile to verify WebGL, Canvas hash, HardwareConcurrency, Timezone, and [native code] anti-tamper integrity.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_check_proxy',
    description: 'Test proxy connectivity and retrieve exit IP, country, city, timezone, and ISP.',
    inputSchema: {
      type: 'object',
      properties: {
        proxy: { type: 'string', description: 'Proxy URL (e.g., http://user:pass@host:port or socks5://host:port).' }
      },
      required: ['proxy'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_list_pages',
    description: 'List open tabs/pages inside a currently running profile.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_navigate',
    description: 'Navigate a running profile tab to a target http/https URL.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        url: { type: 'string', description: 'Target URL (must start with http:// or https://).' },
        waitMs: { type: 'number', description: 'Milliseconds to wait after navigation (default: 2500).' },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId', 'url'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_page_snapshot',
    description: 'Capture a compact structured snapshot of the current page: URL, title, readable text excerpt, and interactive elements with CSS selectors.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        maxTextChars: { type: 'number', description: 'Max characters of visible page text to return (default: 4000).' },
        maxElements: { type: 'number', description: 'Max interactive elements to list (default: 60).' },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_click',
    description: 'Click an element on the active page of a running profile using a CSS selector (from vtn_page_snapshot).',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        selector: { type: 'string', description: 'CSS selector of the element to click.' },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId', 'selector'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_type',
    description: 'Type text into an input, textarea, or contenteditable element on a running profile page.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        selector: { type: 'string', description: 'CSS selector of the input element.' },
        text: { type: 'string', description: 'Text to type.' },
        clear: { type: 'boolean', description: 'Clear existing value before typing (default: true).' },
        pressEnter: { type: 'boolean', description: 'Submit/press Enter after typing (default: false).' },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId', 'selector', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_scroll',
    description: 'Scroll the active page up or down inside a running profile.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        direction: { type: 'string', enum: ['down', 'up'], description: 'Scroll direction (default: "down").' },
        amount: { type: 'number', description: 'Pixels to scroll (default: 600).' },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_screenshot',
    description: 'Capture a screenshot of the active page in a running profile and return it as an image for visual inspection.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        fullPage: { type: 'boolean', description: 'Capture beyond viewport (default: false).' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format (default: "png").' },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_evaluate_js',
    description: 'Evaluate a JavaScript expression inside the active page of a running profile and return its serialized value.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        expression: { type: 'string', description: 'JavaScript expression or IIFE to evaluate.' },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId', 'expression'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_update_profile',
    description: 'Update metadata, proxy configuration, autoGeoIp, startUrl, notes, or tags for an existing VTN Anti-Browser profile.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target profile ID to update.' },
        name: { type: 'string', description: 'Updated display name.' },
        groupName: { type: 'string', description: 'Updated group name.' },
        proxy: { type: 'string', description: 'Updated proxy URL (e.g. http://user:pass@host:port or socks5://host:port), or empty string for direct.' },
        autoGeoIp: { type: 'boolean', description: 'Enable/disable automatic GeoIP timezone & language sync.' },
        startUrl: { type: 'string', description: 'Updated initial URL.' },
        notes: { type: 'string', description: 'Updated notes.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Updated list of tags.' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_delete_profile',
    description: 'Permanently delete a profile and purge its local Chromium user-data directory. Pass force=true to close it first if running.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target profile ID to delete.' },
        force: { type: 'boolean', description: 'If true and profile is currently running, close it before deleting (default: false).' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_cloud_sync',
    description: 'Manage Cloudflare R2 multi-machine profile sync: check status, sync all profiles, or upload/download a specific profile.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'sync_all', 'upload', 'download'], description: 'Cloud sync action to perform.' },
        profileId: { type: 'string', description: 'Profile ID (required for upload and download actions).' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_new_tab',
    description: 'Open a new tab inside a currently running profile via CDP Target.createTarget.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        url: { type: 'string', description: 'Initial URL to open in the new tab (http:, https:, or about:blank; default: "about:blank").' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_close_tab',
    description: 'Close a specific tab in a running profile by targetIndex or targetId. Refuses to close the last remaining tab.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        targetIndex: { type: 'number', description: 'Optional 0-based tab index from vtn_list_pages.' },
        targetId: { type: 'string', description: 'Optional target ID from vtn_list_pages or vtn_new_tab.' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_wait_for_selector',
    description: 'Wait until a CSS selector appears in the DOM of a running profile tab, or fail on timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        selector: { type: 'string', description: 'CSS selector to wait for.' },
        timeoutMs: { type: 'number', description: 'Maximum wait time in milliseconds (default: 10000, max: 60000).' },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId', 'selector'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_press_key',
    description: 'Send a keyboard press event (Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Space, or single char) to a running profile tab.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        key: { type: 'string', description: 'Key name (e.g. "Enter", "Escape", "Tab", "ArrowDown", "Space") or single character.' },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId', 'key'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_select_option',
    description: 'Select an option inside an HTML <select> element by value or visible label and dispatch input/change events.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        selector: { type: 'string', description: 'CSS selector of the <select> element.' },
        value: { type: 'string', description: 'Option value attribute to select.' },
        label: { type: 'string', description: 'Visible option label text to select (used if value is omitted or not matched).' },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId', 'selector'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_get_cookies',
    description: 'Read cookies from a running profile via CDP Network.getCookies (optionally filtered by URLs).',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        urls: { type: 'array', items: { type: 'string' }, description: 'Optional list of URLs to filter cookies.' },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_set_cookies',
    description: 'Inject up to 200 cookies into a running profile via CDP Network.setCookies.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target running profile ID.' },
        cookies: {
          type: 'array',
          description: 'Array of cookie objects (max 200) with name, value, and optional url/domain/path/secure/httpOnly/sameSite/expires.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
              url: { type: 'string' },
              domain: { type: 'string' },
              path: { type: 'string' },
              secure: { type: 'boolean' },
              httpOnly: { type: 'boolean' },
              sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] },
              expires: { type: 'number' }
            },
            required: ['name', 'value']
          }
        },
        targetIndex: { type: 'number', description: 'Optional tab index (default: 0).' }
      },
      required: ['profileId', 'cookies'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_audit_profile',
    description: 'Run the VTN AI Fingerprint & Stealth Auditor on a profile (deterministic checks + live CDP probe if open + optional GeoIP/LLM analysis) and optionally auto-apply safe fixes.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: { type: 'string', description: 'Target profile ID to audit.' },
        platform: { type: 'string', description: 'Target platform context (e.g. "General", "Facebook / Meta", "TikTok", "Google Ads", "Amazon / eBay").' },
        checkProxy: { type: 'boolean', description: 'Whether to run live proxy GeoIP check (default: true).' },
        autoFix: { type: 'boolean', description: 'If true, automatically apply whitelisted suggestedPatch fixes to the profile (default: false).' }
      },
      required: ['profileId'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_warming_control',
    description: 'Control VTN AI Account Warming jobs: list built-in persona presets, inspect active/recent job status, start warming for 1-5 profiles, or stop jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['presets', 'status', 'start', 'stop'], description: 'Warming control action.' },
        profileIds: { type: 'array', items: { type: 'string' }, description: 'Profile IDs to warm (required for action="start", max 5).' },
        persona: { type: 'string', description: 'Custom persona description for natural browsing.' },
        presetId: { type: 'string', description: 'Preset ID from action="presets" (e.g. "us_tech_shopper", "ecom_seller", "gaming_entertainment").' },
        durationMinutes: { type: 'number', description: 'Target warming duration in minutes (0.5..30, default: 3).' },
        maxSteps: { type: 'number', description: 'Maximum sites to visit per profile (1..10, default: 4).' },
        jobId: { type: 'string', description: 'Specific warming job ID to stop (optional for action="stop"; omit to stop all).' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  {
    name: 'vtn_plan_matrix',
    description: 'Generate an anti-collision multi-profile hardware/locale/proxy matrix plan and optionally materialize all planned profiles into SQLite.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Campaign or fleet objective (e.g. "10 US Amazon seller profiles").' },
        count: { type: 'number', description: 'Number of profiles to plan (1..50, default: 5).' },
        platform: { type: 'string', description: 'Target platform (default: "General").' },
        region: { type: 'string', description: 'Target region code such as US, GB, DE, JP, SG, VN (default: "US").' },
        proxiesText: { type: 'string', description: 'Optional newline-separated proxy list to distribute across planned profiles.' },
        apply: { type: 'boolean', description: 'If true, immediately create the planned profiles in the database (default: false).' }
      },
      required: ['goal'],
      additionalProperties: false
    }
  }
];

const MCP_RESOURCES = [
  {
    uri: 'vtn://status',
    name: 'VTN Anti-Browser System Status',
    description: 'Kernel version, active sessions, and MCP statistics.',
    mimeType: 'application/json'
  },
  {
    uri: 'vtn://profiles',
    name: 'VTN Anti-Browser Profiles',
    description: 'JSON list of all configured antidetect profiles and their running status.',
    mimeType: 'application/json'
  }
];

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error: err };
}

const ALLOWED_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function isLocalHostname(hostname) {
  return ALLOWED_LOCAL_HOSTS.has(String(hostname || '').toLowerCase());
}

function extractHostWithoutPort(hostHeader) {
  if (!hostHeader || typeof hostHeader !== 'string') return '';
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const endBracket = trimmed.indexOf(']');
    if (endBracket === -1) return '';
    const rest = trimmed.slice(endBracket + 1);
    if (rest && !/^:\d+$/.test(rest)) return '';
    return trimmed.slice(0, endBracket + 1);
  }
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx !== -1) {
    const portPart = trimmed.slice(colonIdx + 1);
    if (!/^\d+$/.test(portPart)) return '';
    return trimmed.slice(0, colonIdx);
  }
  return trimmed;
}

function validateLocalOriginAndHost(req) {
  const hostHeader = req?.headers?.host;
  if (hostHeader) {
    const hostOnly = extractHostWithoutPort(String(hostHeader));
    if (!ALLOWED_LOCAL_HOSTS.has(hostOnly)) {
      return { ok: false, status: 403, error: 'Forbidden Host' };
    }
  }

  const originHeader = req?.headers?.origin;
  let validatedOrigin = null;
  if (originHeader) {
    try {
      const parsed = new URL(String(originHeader));
      if (!['http:', 'https:'].includes(parsed.protocol) || !isLocalHostname(parsed.hostname)) {
        return { ok: false, status: 403, error: 'Forbidden Origin' };
      }
      validatedOrigin = String(originHeader);
    } catch {
      return { ok: false, status: 403, error: 'Forbidden Origin' };
    }
  }

  return { ok: true, origin: validatedOrigin };
}

function parseProxyInput(proxyStr) {
  if (!proxyStr || typeof proxyStr !== 'string' || !proxyStr.trim()) {
    return { mode: 'direct', type: 'direct' };
  }
  const norm = normalizeProxyConfig(proxyStr);
  if (!norm || !norm.host || !norm.port) {
    throw new Error(`Invalid proxy configuration: ${proxyStr}`);
  }
  return {
    type: norm.type,
    mode: norm.type,
    host: norm.host,
    port: norm.port,
    username: norm.username,
    password: norm.password
  };
}

class VtnMcpServer {
  constructor({ db, browserManager, aiClient, aiWarmer } = {}) {
    this.db = db;
    this.browserManager = browserManager;
    this.aiClient = aiClient || new AiClient();
    this.aiWarmer = aiWarmer || new AiAccountWarmer({
      db: this.db,
      browserManager: this.browserManager,
      aiClient: this.aiClient
    });
    this.sessions = new Map();
    this.stats = {
      totalCalls: 0,
      lastCallAt: null,
      lastToolName: null
    };
  }

  getTools() {
    return MCP_TOOLS;
  }

  getStats() {
    return {
      protocolVersion: SUPPORTED_PROTOCOL_VERSION,
      toolCount: MCP_TOOLS.length,
      resourceCount: MCP_RESOURCES.length,
      activeSessions: this.sessions.size,
      ...this.stats
    };
  }

  _requireRunningSession(profileId) {
    if (!profileId) {
      throw new Error('Missing required parameter: profileId');
    }
    const session = this.browserManager.getSession(profileId);
    if (!session) {
      throw new Error(`Profile "${profileId}" is not currently running. Call vtn_open_profile first.`);
    }
    return session;
  }

  async _executeTool(name, args = {}) {
    this.stats.totalCalls += 1;
    this.stats.lastCallAt = new Date().toISOString();
    this.stats.lastToolName = name;

    switch (name) {
      case 'vtn_list_profiles': {
        const runningMap = new Map(
          this.browserManager.listActiveSessions().map((s) => [s.profileId, s])
        );
        let profiles = this.db.listProfiles().map((p) => {
          const run = runningMap.get(p.id);
          return {
            id: p.id,
            name: p.name,
            groupName: p.groupName,
            blueprintId: p.fingerprint?.blueprintId || null,
            os: p.fingerprint?.os || null,
            proxyMode: p.proxyConfig?.type || p.proxyConfig?.mode || 'direct',
            autoGeoIp: Boolean(p.autoGeoIp),
            startUrl: p.startUrl,
            running: Boolean(run),
            debuggingPort: run ? run.debuggingPort : null
          };
        });
        if (args.groupName) {
          const targetGroup = String(args.groupName).toLowerCase();
          profiles = profiles.filter((p) => (p.groupName || '').toLowerCase() === targetGroup);
        }
        if (args.runningOnly) {
          profiles = profiles.filter((p) => p.running);
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ count: profiles.length, profiles }, null, 2) }]
        };
      }

      case 'vtn_list_blueprints': {
        const blueprints = Object.values(HARDWARE_BLUEPRINTS).map((b) => ({
          id: b.id,
          label: b.label,
          category: b.category || 'Desktop',
          os: b.os,
          platform: b.platform,
          manufacturer: b.manufacturer
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify({ count: blueprints.length, blueprints }, null, 2) }]
        };
      }

      case 'vtn_create_unique_profile': {
        const proxyConfig = args.proxy ? parseProxyInput(args.proxy) : { mode: 'direct', type: 'direct' };
        const created = this.db.createProfile({
          name: args.name || undefined,
          groupName: args.groupName || 'Default',
          notes: args.notes || '',
          proxyConfig,
          autoGeoIp: Boolean(args.autoGeoIp),
          startUrl: args.startUrl || 'about:blank',
          ensureUnique: true,
          fingerprintOverrides: args.blueprintId ? { blueprintId: args.blueprintId } : {}
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: created.id,
              name: created.name,
              groupName: created.groupName,
              blueprintId: created.fingerprint?.blueprintId,
              os: created.fingerprint?.os,
              screen: created.fingerprint?.screen,
              proxyMode: created.proxyConfig?.type || created.proxyConfig?.mode || 'direct'
            }, null, 2)
          }]
        };
      }

      case 'vtn_open_profile': {
        const profile = this.db.getProfile(args.profileId);
        if (!profile) {
          throw new Error(`Profile not found: ${args.profileId}`);
        }
        const session = await this.browserManager.openProfile(profile, {
          headless: Boolean(args.headless)
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(session, null, 2) }]
        };
      }

      case 'vtn_close_profile': {
        if (!args.profileId) throw new Error('Missing required parameter: profileId');
        const closed = await this.browserManager.closeProfile(args.profileId);
        return {
          content: [{ type: 'text', text: JSON.stringify({ profileId: args.profileId, closed }, null, 2) }]
        };
      }

      case 'vtn_probe_fingerprint': {
        const session = this._requireRunningSession(args.profileId);
        const probe = await probeRunningProfile(session.debuggingPort, 8000);
        return {
          content: [{ type: 'text', text: JSON.stringify(probe, null, 2) }]
        };
      }

      case 'vtn_check_proxy': {
        if (!args.proxy) throw new Error('Missing required parameter: proxy');
        const parsed = parseProxyInput(args.proxy);
        const check = await checkProxyConnectivity(parsed);
        return {
          content: [{ type: 'text', text: JSON.stringify(check, null, 2) }]
        };
      }

      case 'vtn_list_pages': {
        const session = this._requireRunningSession(args.profileId);
        const pages = await listPages(session.debuggingPort);
        return {
          content: [{ type: 'text', text: JSON.stringify({ profileId: args.profileId, pages }, null, 2) }]
        };
      }

      case 'vtn_navigate': {
        const session = this._requireRunningSession(args.profileId);
        const nav = await navigatePage(session.debuggingPort, args.url, {
          waitMs: args.waitMs,
          targetIndex: args.targetIndex
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(nav, null, 2) }]
        };
      }

      case 'vtn_page_snapshot': {
        const session = this._requireRunningSession(args.profileId);
        const snapshot = await getPageSnapshot(session.debuggingPort, {
          maxTextChars: args.maxTextChars,
          maxElements: args.maxElements,
          targetIndex: args.targetIndex
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }]
        };
      }

      case 'vtn_click': {
        const session = this._requireRunningSession(args.profileId);
        const res = await clickElement(session.debuggingPort, args.selector, {
          targetIndex: args.targetIndex
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
        };
      }

      case 'vtn_type': {
        const session = this._requireRunningSession(args.profileId);
        const res = await typeText(session.debuggingPort, args.selector, args.text, {
          clear: args.clear,
          pressEnter: args.pressEnter,
          targetIndex: args.targetIndex
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
        };
      }

      case 'vtn_scroll': {
        const session = this._requireRunningSession(args.profileId);
        const res = await scrollPage(session.debuggingPort, {
          direction: args.direction,
          amount: args.amount,
          targetIndex: args.targetIndex
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
        };
      }

      case 'vtn_screenshot': {
        const session = this._requireRunningSession(args.profileId);
        const shot = await captureScreenshot(session.debuggingPort, {
          fullPage: args.fullPage,
          format: args.format,
          targetIndex: args.targetIndex
        });
        return {
          content: [
            {
              type: 'image',
              data: shot.base64,
              mimeType: shot.mimeType
            },
            {
              type: 'text',
              text: JSON.stringify({ format: shot.format, bytes: shot.bytes })
            }
          ]
        };
      }

      case 'vtn_evaluate_js': {
        const session = this._requireRunningSession(args.profileId);
        const value = await evaluateScript(session.debuggingPort, args.expression, {
          targetIndex: args.targetIndex
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ value }, null, 2) }]
        };
      }

      case 'vtn_update_profile': {
        if (!args.profileId) throw new Error('Missing required parameter: profileId');
        const patch = {};
        if (args.name !== undefined) patch.name = String(args.name);
        if (args.groupName !== undefined) patch.groupName = String(args.groupName);
        if (args.proxy !== undefined) patch.proxyConfig = parseProxyInput(args.proxy);
        if (args.autoGeoIp !== undefined) patch.autoGeoIp = Boolean(args.autoGeoIp);
        if (args.startUrl !== undefined) patch.startUrl = String(args.startUrl);
        if (args.notes !== undefined) patch.notes = String(args.notes);
        if (args.tags !== undefined) {
          if (!Array.isArray(args.tags)) throw new Error('tags must be an array of strings');
          patch.tags = args.tags.map((t) => String(t).trim()).filter(Boolean);
        }
        const updated = this.db.updateProfile(args.profileId, patch);
        if (!updated) {
          throw new Error(`Profile not found: ${args.profileId}`);
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: updated.id,
              name: updated.name,
              groupName: updated.groupName,
              proxyMode: updated.proxyConfig?.type || updated.proxyConfig?.mode || 'direct',
              autoGeoIp: Boolean(updated.autoGeoIp),
              startUrl: updated.startUrl,
              notes: updated.notes,
              tags: updated.tags,
              updatedAt: updated.updatedAt
            }, null, 2)
          }]
        };
      }

      case 'vtn_delete_profile': {
        if (!args.profileId) throw new Error('Missing required parameter: profileId');
        const existing = this.db.getProfile(args.profileId);
        if (!existing) {
          throw new Error(`Profile not found: ${args.profileId}`);
        }
        if (this.browserManager.isRunning(args.profileId)) {
          if (!args.force) {
            throw new Error(`Profile "${args.profileId}" is currently running. Close it first or pass force: true.`);
          }
          await this.browserManager.closeProfile(args.profileId);
        }
        await this.browserManager.purgeProfileDiskData(args.profileId);
        const deleted = this.db.deleteProfile(args.profileId);
        return {
          content: [{ type: 'text', text: JSON.stringify({ profileId: args.profileId, deleted }, null, 2) }]
        };
      }

      case 'vtn_cloud_sync': {
        const action = String(args.action || '').trim();
        const cloudSync = this.browserManager.cloudSync;
        if (action === 'status') {
          const status = cloudSync
            ? await cloudSync.getCloudStatus()
            : { enabled: false, connected: false };
          return {
            content: [{ type: 'text', text: JSON.stringify(status, null, 2) }]
          };
        }
        if (!cloudSync || !cloudSync.isEnabled()) {
          throw new Error('Cloudflare R2 is disabled or not configured');
        }
        if (action === 'sync_all') {
          const result = await cloudSync.syncAllProfiles(this.db, this.browserManager.profilesDir);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }
        if (action === 'upload' || action === 'download') {
          if (!args.profileId) {
            throw new Error(`Missing required parameter: profileId for action "${action}"`);
          }
          if (this.browserManager.isRunning(args.profileId)) {
            throw new Error(`Profile "${args.profileId}" is currently running. Close it before ${action}.`);
          }
          const result = action === 'upload'
            ? await cloudSync.uploadProfileData(args.profileId, this.db, this.browserManager.profilesDir)
            : await cloudSync.downloadProfileData(args.profileId, this.db, this.browserManager.profilesDir);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }
        throw new Error(`Unsupported cloud sync action: ${action}`);
      }

      case 'vtn_new_tab': {
        const session = this._requireRunningSession(args.profileId);
        const res = await newTab(session.debuggingPort, args.url);
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
        };
      }

      case 'vtn_close_tab': {
        const session = this._requireRunningSession(args.profileId);
        const res = await closeTab(session.debuggingPort, {
          targetIndex: args.targetIndex,
          targetId: args.targetId
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
        };
      }

      case 'vtn_wait_for_selector': {
        const session = this._requireRunningSession(args.profileId);
        const res = await waitForSelector(session.debuggingPort, args.selector, {
          timeoutMs: args.timeoutMs,
          targetIndex: args.targetIndex
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
        };
      }

      case 'vtn_press_key': {
        const session = this._requireRunningSession(args.profileId);
        const res = await pressKey(session.debuggingPort, args.key, {
          targetIndex: args.targetIndex
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
        };
      }

      case 'vtn_select_option': {
        const session = this._requireRunningSession(args.profileId);
        const res = await selectOption(session.debuggingPort, args.selector, {
          value: args.value,
          label: args.label,
          targetIndex: args.targetIndex
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
        };
      }

      case 'vtn_get_cookies': {
        const session = this._requireRunningSession(args.profileId);
        const res = await getCookies(session.debuggingPort, {
          urls: args.urls,
          targetIndex: args.targetIndex
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
        };
      }

      case 'vtn_set_cookies': {
        const session = this._requireRunningSession(args.profileId);
        const res = await setCookies(session.debuggingPort, args.cookies, {
          targetIndex: args.targetIndex
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(res, null, 2) }]
        };
      }

      case 'vtn_audit_profile': {
        if (!args.profileId) throw new Error('Missing required parameter: profileId');
        const report = await auditProfile({
          db: this.db,
          browserManager: this.browserManager,
          aiClient: this.aiClient,
          profileId: args.profileId,
          platform: args.platform || 'General',
          checkProxy: args.checkProxy !== false
        });
        let autoFixResult = null;
        if (args.autoFix && report.suggestedPatch) {
          autoFixResult = applyAuditFix(this.db, args.profileId, report.suggestedPatch);
        }
        const payload = autoFixResult
          ? { ...report, autoFixApplied: autoFixResult.appliedFields }
          : report;
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }]
        };
      }

      case 'vtn_warming_control': {
        const action = String(args.action || '').trim();
        if (action === 'presets') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ presets: WARMING_PRESETS }, null, 2) }]
          };
        }
        if (action === 'status') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ jobs: this.aiWarmer.getStatus() }, null, 2) }]
          };
        }
        if (action === 'start') {
          const result = this.aiWarmer.startWarming({
            profileIds: args.profileIds,
            persona: args.persona,
            presetId: args.presetId,
            durationMinutes: args.durationMinutes,
            maxSteps: args.maxSteps
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }
        if (action === 'stop') {
          const result = args.jobId
            ? this.aiWarmer.stopWarming(args.jobId)
            : this.aiWarmer.stopAll();
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }
        throw new Error(`Unsupported warming action: ${action}`);
      }

      case 'vtn_plan_matrix': {
        if (!args.goal || !String(args.goal).trim()) {
          throw new Error('Missing required parameter: goal');
        }
        const plan = await generateMatrixPlan({
          db: this.db,
          aiClient: this.aiClient,
          goal: args.goal,
          count: args.count,
          platform: args.platform || 'General',
          region: args.region || 'US',
          proxiesText: args.proxiesText || ''
        });
        let applied = null;
        if (args.apply) {
          const res = applyMatrixPlan(this.db, plan.items);
          applied = {
            createdCount: res.createdCount,
            profileIds: res.profiles.map((p) => p.id)
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ plan, applied }, null, 2) }]
        };
      }

      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }

  async _readResource(uri) {
    if (uri === 'vtn://status') {
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            kernelVersion: '151.0.7922.109',
            chromeExe: this.browserManager.chromeExe,
            activeSessions: this.browserManager.listActiveSessions(),
            mcp: this.getStats()
          }, null, 2)
        }]
      };
    }

    if (uri === 'vtn://profiles') {
      const runningMap = new Map(
        this.browserManager.listActiveSessions().map((s) => [s.profileId, s])
      );
      const profiles = this.db.listProfiles().map((p) => ({
        id: p.id,
        name: p.name,
        groupName: p.groupName,
        running: runningMap.has(p.id),
        debuggingPort: runningMap.get(p.id)?.debuggingPort || null
      }));
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(profiles, null, 2)
        }]
      };
    }

    throw new Error(`Unknown MCP resource URI: ${uri}`);
  }

  /**
   * Processes a single JSON-RPC 2.0 message and returns `{ response, sessionId, isNotification }`.
   */
  async handleRpcMessage(message, incomingSessionId) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || !message.method) {
      return {
        response: jsonRpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC 2.0 request'),
        isNotification: false
      };
    }

    const { id, method } = message;
    const params = (message.params && typeof message.params === 'object') ? message.params : {};
    const isNotification = id === undefined;

    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return { response: null, isNotification: true };
    }

    try {
      if (method === 'initialize') {
        const sessionId = crypto.randomUUID();
        this.sessions.set(sessionId, {
          createdAt: new Date().toISOString(),
          clientInfo: params.clientInfo || null
        });
        while (this.sessions.size > 100) {
          const oldestKey = this.sessions.keys().next().value;
          if (oldestKey === undefined) break;
          this.sessions.delete(oldestKey);
        }
        return {
          sessionId,
          isNotification: false,
          response: jsonRpcResult(id, {
            protocolVersion: SUPPORTED_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              resources: { listChanged: false }
            },
            serverInfo: {
              name: 'vtn-anti-browser',
              version: '1.0.0'
            },
            instructions: 'VTN Anti-Browser MCP Server: Use vtn_list_profiles or vtn_create_unique_profile, launch with vtn_open_profile, then automate via vtn_navigate, vtn_page_snapshot, vtn_click, vtn_type, vtn_screenshot, and vtn_probe_fingerprint.'
          })
        };
      }

      if (method === 'ping') {
        return { response: jsonRpcResult(id, {}), isNotification: false };
      }

      if (method === 'tools/list') {
        return { response: jsonRpcResult(id, { tools: MCP_TOOLS }), isNotification: false };
      }

      if (method === 'tools/call') {
        const toolName = params.name;
        const toolArgs = params.arguments || {};
        try {
          const result = await this._executeTool(toolName, toolArgs);
          return {
            response: jsonRpcResult(id, { ...result, isError: false }),
            isNotification: false
          };
        } catch (toolErr) {
          return {
            response: jsonRpcResult(id, {
              content: [{ type: 'text', text: `Error executing ${toolName}: ${toolErr.message}` }],
              isError: true
            }),
            isNotification: false
          };
        }
      }

      if (method === 'resources/list') {
        return { response: jsonRpcResult(id, { resources: MCP_RESOURCES }), isNotification: false };
      }

      if (method === 'resources/read') {
        const res = await this._readResource(params.uri);
        return { response: jsonRpcResult(id, res), isNotification: false };
      }

      if (isNotification) {
        return { response: null, isNotification: true };
      }

      return {
        response: jsonRpcError(id, -32601, `Method not found: ${method}`),
        isNotification: false
      };
    } catch (err) {
      if (isNotification) return { response: null, isNotification: true };
      return {
        response: jsonRpcError(id, -32603, err.message || 'Internal MCP server error'),
        isNotification: false
      };
    }
  }

  /**
   * Handles HTTP requests on `/mcp` according to MCP Streamable HTTP (2025-03-26).
   */
  async handleHttpRequest(req, res, body) {
    const guard = validateLocalOriginAndHost(req);
    if (!guard.ok) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(jsonRpcError(null, -32001, guard.error)));
    }

    const corsHeaders = {
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id'
    };
    if (guard.origin) {
      corsHeaders['Access-Control-Allow-Origin'] = guard.origin;
      corsHeaders['Vary'] = 'Origin';
    }

    if (req.method === 'DELETE') {
      const sid = req.headers['mcp-session-id'];
      if (sid) this.sessions.delete(String(sid));
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (req.method === 'GET') {
      // Streamable HTTP spec: return 405 if server does not offer an SSE stream on GET
      res.writeHead(405, {
        ...corsHeaders,
        Allow: 'POST, DELETE, OPTIONS',
        'Content-Type': 'application/json; charset=utf-8'
      });
      return res.end(JSON.stringify({
        ok: false,
        error: 'Method Not Allowed. Send JSON-RPC 2.0 POST requests to /mcp (MCP Streamable HTTP 2025-03-26).'
      }));
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { ...corsHeaders, Allow: 'POST, DELETE, OPTIONS' });
      return res.end();
    }

    const incomingSid = req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : undefined;

    // Support JSON-RPC batch arrays as well as single objects
    if (Array.isArray(body)) {
      const responses = [];
      let assignedSid = incomingSid;
      for (const item of body) {
        const outcome = await this.handleRpcMessage(item, assignedSid);
        if (outcome.sessionId) assignedSid = outcome.sessionId;
        if (!outcome.isNotification && outcome.response) {
          responses.push(outcome.response);
        }
      }
      const headers = { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' };
      if (assignedSid) headers['Mcp-Session-Id'] = assignedSid;
      if (responses.length === 0) {
        res.writeHead(202, headers);
        return res.end();
      }
      res.writeHead(200, headers);
      return res.end(JSON.stringify(responses));
    }

    const outcome = await this.handleRpcMessage(body, incomingSid);
    const headers = { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' };
    if (outcome.sessionId) {
      headers['Mcp-Session-Id'] = outcome.sessionId;
    } else if (incomingSid) {
      headers['Mcp-Session-Id'] = incomingSid;
    }

    if (outcome.isNotification || !outcome.response) {
      res.writeHead(202, headers);
      return res.end();
    }

    res.writeHead(200, headers);
    return res.end(JSON.stringify(outcome.response));
  }
}

module.exports = {
  VtnMcpServer,
  MCP_TOOLS,
  MCP_RESOURCES,
  SUPPORTED_PROTOCOL_VERSION,
  validateLocalOriginAndHost
};
