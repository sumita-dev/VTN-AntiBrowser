/**
 * VTN-Browser Zero-Dependency AI Client (`src/core/ai-client.js`)
 * Supports Gemini, OpenAI-compatible (OpenAI / OpenRouter / DeepSeek / Groq),
 * and local Ollama via Node.js >= 22 built-in `fetch` + `AbortSignal.timeout`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('./paths');

const DEFAULT_AI_CONFIG_PATH = path.join(DATA_DIR, 'ai_config.json');
const DEFAULT_TIMEOUT_MS = 45000;

const PROVIDER_DEFAULTS = {
  gemini: {
    model: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
  },
  openai: {
    model: 'gpt-4o-mini',
    baseUrl: 'https://api.openai.com/v1'
  },
  ollama: {
    model: 'llama3.2',
    baseUrl: 'http://127.0.0.1:11434'
  }
};

function normalizeProvider(provider) {
  const p = String(provider || 'gemini').trim().toLowerCase();
  if (p === 'gemini' || p === 'openai' || p === 'ollama') return p;
  return 'gemini';
}

function maskApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function stripDataUriPrefix(base64Str) {
  const raw = String(base64Str || '').trim();
  const idx = raw.indexOf('base64,');
  return idx !== -1 ? raw.slice(idx + 7).trim() : raw;
}

/**
 * Safely parses JSON from an LLM response, stripping markdown code fences
 * or surrounding prose if present.
 *
 * @param {string} rawText
 * @returns {any}
 */
function extractJsonFromText(rawText) {
  const text = String(rawText || '').trim();
  if (!text) {
    throw new Error('LLM returned an empty response when JSON was expected.');
  }

  // 1. Direct parse
  try {
    return JSON.parse(text);
  } catch {
    // Continue to fence stripping
  }

  // 2. Strip ```json ... ``` or ``` ... ``` fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue to bracket extraction
    }
  }

  // 3. Extract outermost JSON object or array
  const firstObj = text.indexOf('{');
  const lastObj = text.lastIndexOf('}');
  const firstArr = text.indexOf('[');
  const lastArr = text.lastIndexOf(']');

  const candidates = [];
  if (firstObj !== -1 && lastObj > firstObj) {
    candidates.push({ start: firstObj, str: text.slice(firstObj, lastObj + 1) });
  }
  if (firstArr !== -1 && lastArr > firstArr) {
    candidates.push({ start: firstArr, str: text.slice(firstArr, lastArr + 1) });
  }
  candidates.sort((a, b) => a.start - b.start);

  for (const c of candidates) {
    try {
      return JSON.parse(c.str);
    } catch {
      // Try next candidate
    }
  }

  throw new Error(`Failed to parse JSON from LLM output: ${text.slice(0, 200)}`);
}

class AiClient {
  constructor(configPath = DEFAULT_AI_CONFIG_PATH) {
    this.configPath = configPath;
    this._config = this._loadConfig();
  }

  _defaultConfig() {
    return {
      provider: 'gemini',
      model: PROVIDER_DEFAULTS.gemini.model,
      baseUrl: PROVIDER_DEFAULTS.gemini.baseUrl,
      apiKey: '',
      enabled: false
    };
  }

  _loadConfig() {
    const defaults = this._defaultConfig();
    try {
      if (fs.existsSync(this.configPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        const provider = normalizeProvider(parsed.provider || defaults.provider);
        const pDef = PROVIDER_DEFAULTS[provider];
        return {
          provider,
          model: String(parsed.model || pDef.model).trim() || pDef.model,
          baseUrl: String(parsed.baseUrl || pDef.baseUrl).trim() || pDef.baseUrl,
          apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '',
          enabled: Boolean(parsed.enabled)
        };
      }
    } catch {
      // Fall back to defaults on corrupt config
    }
    return defaults;
  }

  _persistConfig() {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this._config, null, 2), 'utf8');
  }

  /**
   * Returns masked configuration safe for UI/API exposure. Never leaks raw apiKey.
   */
  getMaskedConfig() {
    const cfg = this._config;
    const hasApiKey = Boolean(cfg.apiKey && cfg.apiKey.trim().length > 0);
    return {
      provider: cfg.provider,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      enabled: Boolean(cfg.enabled),
      hasApiKey,
      apiKeyPreview: maskApiKey(cfg.apiKey)
    };
  }

  /**
   * Updates and persists AI configuration.
   * Preserves existing `apiKey` if `patch.apiKey` is omitted or empty.
   *
   * @param {Object} [patch={}]
   */
  saveConfig(patch = {}) {
    const prev = this._config;
    const nextProvider = patch.provider !== undefined
      ? normalizeProvider(patch.provider)
      : prev.provider;
    const pDef = PROVIDER_DEFAULTS[nextProvider];
    const providerChanged = nextProvider !== prev.provider;

    let nextModel = prev.model;
    if (patch.model !== undefined && String(patch.model).trim()) {
      nextModel = String(patch.model).trim();
    } else if (providerChanged || !nextModel) {
      nextModel = pDef.model;
    }

    let nextBaseUrl = prev.baseUrl;
    if (patch.baseUrl !== undefined && String(patch.baseUrl).trim()) {
      nextBaseUrl = String(patch.baseUrl).trim().replace(/\/+$/, '');
    } else if (providerChanged || !nextBaseUrl) {
      nextBaseUrl = pDef.baseUrl;
    }

    let nextApiKey = prev.apiKey || '';
    if (patch.clearApiKey === true) {
      nextApiKey = '';
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim().length > 0) {
      nextApiKey = patch.apiKey.trim();
    }

    const nextEnabled = patch.enabled !== undefined
      ? Boolean(patch.enabled)
      : prev.enabled;

    this._config = {
      provider: nextProvider,
      model: nextModel,
      baseUrl: nextBaseUrl,
      apiKey: nextApiKey,
      enabled: nextEnabled
    };

    this._persistConfig();
    return this.getMaskedConfig();
  }

  /**
   * Returns true if AI is enabled and has credentials (or uses local Ollama).
   */
  isConfigured() {
    if (!this._config.enabled) return false;
    if (this._config.provider === 'ollama') return true;
    return Boolean(this._config.apiKey && this._config.apiKey.trim().length > 0);
  }

  _assertReady() {
    if (!this._config.enabled) {
      throw new Error('AI client is disabled in configuration.');
    }
    if (this._config.provider !== 'ollama' && !this._config.apiKey) {
      throw new Error(`API key is required for provider "${this._config.provider}".`);
    }
  }

  async _fetchJson(url, options) {
    const res = await fetch(url, Object.assign({}, options, {
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
    }));
    const rawBody = await res.text();
    let parsed = null;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const errMsg = (parsed && (parsed.error?.message || parsed.error || parsed.message))
        || rawBody.slice(0, 300)
        || `HTTP ${res.status}`;
      const err = new Error(`AI provider error (${res.status}): ${errMsg}`);
      err.status = res.status;
      throw err;
    }
    return parsed;
  }

  async _callGemini({ systemPrompt, prompt, temperature = 0.2, expectJson = false, imageBase64 = null, mimeType = 'image/png' }) {
    const base = (this._config.baseUrl || PROVIDER_DEFAULTS.gemini.baseUrl).replace(/\/+$/, '');
    const model = this._config.model || PROVIDER_DEFAULTS.gemini.model;
    const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this._config.apiKey)}`;

    const parts = [{ text: String(prompt || '') }];
    if (imageBase64) {
      parts.push({
        inline_data: {
          mime_type: mimeType || 'image/png',
          data: stripDataUriPrefix(imageBase64)
        }
      });
    }

    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: typeof temperature === 'number' ? temperature : 0.2
      }
    };
    if (systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: String(systemPrompt) }]
      };
    }
    if (expectJson) {
      body.generationConfig.responseMimeType = 'application/json';
    }

    const data = await this._fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const candidateParts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(candidateParts) || candidateParts.length === 0) {
      throw new Error('Gemini returned no content candidates.');
    }
    return candidateParts.map((p) => p.text || '').join('').trim();
  }

  async _callOpenAi({ systemPrompt, prompt, temperature = 0.2, expectJson = false, imageBase64 = null, mimeType = 'image/png' }) {
    const base = (this._config.baseUrl || PROVIDER_DEFAULTS.openai.baseUrl).replace(/\/+$/, '');
    const model = this._config.model || PROVIDER_DEFAULTS.openai.model;
    const url = `${base}/chat/completions`;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: String(systemPrompt) });
    }

    if (imageBase64) {
      const cleanB64 = stripDataUriPrefix(imageBase64);
      const safeMime = mimeType || 'image/png';
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: String(prompt || '') },
          {
            type: 'image_url',
            image_url: { url: `data:${safeMime};base64,${cleanB64}` }
          }
        ]
      });
    } else {
      messages.push({ role: 'user', content: String(prompt || '') });
    }

    const buildBody = (withResponseFormat) => {
      const b = {
        model,
        temperature: typeof temperature === 'number' ? temperature : 0.2,
        messages
      };
      if (withResponseFormat) {
        b.response_format = { type: 'json_object' };
      }
      return b;
    };

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this._config.apiKey}`
    };

    let data;
    try {
      data = await this._fetchJson(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildBody(Boolean(expectJson)))
      });
    } catch (err) {
      // Some OpenAI-compatible gateways/models reject response_format: json_object
      if (expectJson && err.status === 400) {
        data = await this._fetchJson(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(buildBody(false))
        });
      } else {
        throw err;
      }
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('OpenAI-compatible provider returned empty message content.');
    }
    return content.trim();
  }

  async _callOllama({ systemPrompt, prompt, temperature = 0.2, expectJson = false, imageBase64 = null }) {
    const base = (this._config.baseUrl || PROVIDER_DEFAULTS.ollama.baseUrl).replace(/\/+$/, '');
    const model = this._config.model || PROVIDER_DEFAULTS.ollama.model;
    const url = `${base}/api/chat`;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: String(systemPrompt) });
    }
    const userMsg = { role: 'user', content: String(prompt || '') };
    if (imageBase64) {
      userMsg.images = [stripDataUriPrefix(imageBase64)];
    }
    messages.push(userMsg);

    const body = {
      model,
      stream: false,
      messages,
      options: {
        temperature: typeof temperature === 'number' ? temperature : 0.2
      }
    };
    if (expectJson) {
      body.format = 'json';
    }

    const data = await this._fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const content = data?.message?.content || data?.response || '';
    if (!String(content).trim()) {
      throw new Error('Ollama returned an empty response.');
    }
    return String(content).trim();
  }

  async _dispatch(opts) {
    this._assertReady();
    switch (this._config.provider) {
      case 'gemini':
        return this._callGemini(opts);
      case 'openai':
        return this._callOpenAi(opts);
      case 'ollama':
        return this._callOllama(opts);
      default:
        throw new Error(`Unsupported AI provider: ${this._config.provider}`);
    }
  }

  /**
   * Generates a plain text completion.
   */
  async generateText({ systemPrompt = '', prompt = '', temperature = 0.2 } = {}) {
    return this._dispatch({
      systemPrompt,
      prompt,
      temperature,
      expectJson: false
    });
  }

  /**
   * Requests a JSON completion and safely parses it.
   */
  async generateJson({ systemPrompt = '', prompt = '', temperature = 0.1 } = {}) {
    const jsonSystem = systemPrompt
      ? `${systemPrompt}\nRespond with strictly valid JSON only (no markdown prose).`
      : 'Respond with strictly valid JSON only (no markdown prose).';
    const raw = await this._dispatch({
      systemPrompt: jsonSystem,
      prompt,
      temperature,
      expectJson: true
    });
    return extractJsonFromText(raw);
  }

  /**
   * Sends a base64-encoded image along with a prompt and parses a JSON response.
   */
  async generateVisionJson({
    systemPrompt = '',
    prompt = '',
    imageBase64 = '',
    mimeType = 'image/png',
    temperature = 0.1
  } = {}) {
    if (!imageBase64) {
      throw new Error('imageBase64 is required for generateVisionJson.');
    }
    const jsonSystem = systemPrompt
      ? `${systemPrompt}\nRespond with strictly valid JSON only.`
      : 'Respond with strictly valid JSON only.';
    const raw = await this._dispatch({
      systemPrompt: jsonSystem,
      prompt,
      temperature,
      expectJson: true,
      imageBase64,
      mimeType
    });
    return extractJsonFromText(raw);
  }

  /**
   * Tests live connectivity with a tiny prompt.
   */
  async testConnection() {
    const startMs = Date.now();
    const provider = this._config.provider;
    const model = this._config.model;

    if (provider !== 'ollama' && !this._config.apiKey) {
      return {
        ok: false,
        provider,
        model,
        latencyMs: Date.now() - startMs,
        reply: '',
        error: `API key is missing for provider "${provider}".`
      };
    }

    try {
      // Allow testing connection even before `enabled` is toggled on
      let reply = '';
      const opts = {
        systemPrompt: 'Reply briefly in 5 words or fewer.',
        prompt: 'Reply with: OK VTN',
        temperature: 0,
        expectJson: false
      };
      if (provider === 'gemini') reply = await this._callGemini(opts);
      else if (provider === 'openai') reply = await this._callOpenAi(opts);
      else reply = await this._callOllama(opts);

      return {
        ok: true,
        provider,
        model,
        latencyMs: Date.now() - startMs,
        reply: String(reply || '').slice(0, 200),
        error: null
      };
    } catch (err) {
      return {
        ok: false,
        provider,
        model,
        latencyMs: Date.now() - startMs,
        reply: '',
        error: err.message
      };
    }
  }
}

module.exports = {
  AiClient,
  DEFAULT_AI_CONFIG_PATH,
  PROVIDER_DEFAULTS,
  extractJsonFromText
};
