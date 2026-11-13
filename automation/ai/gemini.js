/**
 * Gemini AI Content & Sentiment Adapter
 * Supports 2D Multi-Key x Multi-Model Round-Robin Rotation (per gemini-api-key-rotation-matrix.md)
 * and Google OAuth 2.0 (via Antigravity 2.0).
 * Analyzes post sentiment, decides reactions, and generates contextual comments.
 */

const fs = require('fs');
const path = require('path');
const { AntigravityAuth } = require('../../src/core/agy-auth');

const AI_CONFIG_PATH = path.resolve(__dirname, '..', '..', 'data', 'ai_config.json');

const DEFAULT_FLASH_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

const RETRYABLE_STATUSES = new Set([403, 429, 500, 503]);

// Persistent module-level counter so consecutive calls distribute evenly across the 2D matrix
let rotationCounter = 0;

class GeminiAdapter {
  constructor(apiKey = null) {
    this.explicitApiKey = apiKey || '';
    this.model = DEFAULT_FLASH_MODELS[0];
    this.agyAuth = new AntigravityAuth();
  }

  _loadSavedConfig() {
    try {
      if (fs.existsSync(AI_CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf8'));
      }
    } catch {}
    return {};
  }

  _resolveApiKeys(savedConfig) {
    const candidates = [];
    if (this.explicitApiKey) candidates.push(this.explicitApiKey);
    if (process.env.GEMINI_API_KEY) candidates.push(process.env.GEMINI_API_KEY);
    if (savedConfig && Array.isArray(savedConfig.apiKeys)) {
      for (const k of savedConfig.apiKeys) candidates.push(k);
    }
    if (savedConfig && typeof savedConfig.apiKey === 'string' && savedConfig.apiKey) {
      candidates.push(savedConfig.apiKey);
    }

    const seen = new Set();
    const keys = [];
    for (const raw of candidates) {
      const trimmed = typeof raw === 'string' ? raw.trim() : '';
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      keys.push(trimmed);
    }
    return keys;
  }

  _resolveModels(savedConfig) {
    if (savedConfig && Array.isArray(savedConfig.models) && savedConfig.models.length > 0) {
      const cleaned = savedConfig.models
        .map((m) => (typeof m === 'string' ? m.trim() : ''))
        .filter(Boolean);
      if (cleaned.length > 0) return cleaned;
    }
    return DEFAULT_FLASH_MODELS;
  }

  async analyzePost(postText, locale = null, customPersona = '') {
    if (!postText || postText.trim().length < 10) {
      return { reaction: 'SKIP', shouldInteract: false, comment: '', reason: 'Text too short' };
    }

    const savedConfig = this._loadSavedConfig();
    const resolvedLocale = locale || savedConfig.locale || 'VN';
    const resolvedPersona = customPersona || savedConfig.persona || '';
    const maxChars = Number(savedConfig.maxChars) || 120;

    // 1. 2D Multi-Key x Multi-Model Round-Robin Rotation (when API keys exist)
    const keys = this._resolveApiKeys(savedConfig);
    const models = this._resolveModels(savedConfig);
    if (keys.length > 0) {
      const totalSlots = keys.length * models.length;
      const maxAttempts = Math.min(totalSlots, 12);

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const slotIndex = (rotationCounter++) % totalSlots;
        const apiKey = keys[slotIndex % keys.length];
        const model = models[Math.floor(slotIndex / keys.length) % models.length];

        try {
          const result = await this._callWithApiKey(postText, resolvedLocale, resolvedPersona, apiKey, maxChars, model);
          if (result) return result;
        } catch (err) {
          const status = err && err.status;
          const isRetryable = !status || RETRYABLE_STATUSES.has(status) || err.name === 'TimeoutError' || err.name === 'AbortError';
          process.stderr.write(`[Gemini] Slot (${model} / key#${(slotIndex % keys.length) + 1}) error: ${err.message}\n`);
          if (!isRetryable) break;
        }
      }
    }

    // 2. Google OAuth Access Token fallback via Antigravity 2.0
    try {
      const accessToken = await this.agyAuth.getValidAccessToken();
      if (typeof accessToken === 'string' && accessToken.length > 0) {
        const oauthResult = await this._callWithBearerToken(postText, resolvedLocale, accessToken, resolvedPersona, maxChars);
        if (oauthResult) return oauthResult;
      }
    } catch (err) {
      process.stderr.write('[Gemini] OAuth token unavailable: ' + err.message + '\n');
    }

    // 3. Heuristic fallback
    return this._generateHeuristic(postText, resolvedLocale);
  }

  _buildPrompt(postText, locale, customPersona, maxChars = 120) {
    const personaPrompt = customPersona
      ? customPersona
      : 'Ban la mot nguoi dung mang xa hoi ' + (locale === 'VN' ? 'Viet Nam' : 'My') + ' tu nhien, tich cuc, binh luan ngan gon.';

    return personaPrompt + '\n'
      + 'Hay doc bai viet sau va tra ve duy nhat 1 JSON object co dang:\n'
      + `{"reaction": "LIKE" | "CARE" | "LOVE" | "SKIP", "shouldInteract": true | false, "comment": "binh luan duoi ${maxChars} ky tu sat voi noi dung bai viet", "reason": "ly do ngan gon"}\n\n`
      + 'Bai viet:\n"""\n' + postText.slice(0, 1500) + '\n"""';
  }

  async _callWithBearerToken(postText, locale, accessToken, customPersona, maxChars = 120, model = 'gemini-2.5-flash') {
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
    const prompt = this._buildPrompt(postText, locale, customPersona, maxChars);

    const res = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + accessToken
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.7 }
      })
    });

    const data = await res.json();
    if (!res.ok) {
      process.stderr.write(`[Gemini] OAuth HTTP ${res.status}: ${data?.error?.message || JSON.stringify(data)}\n`);
      return null;
    }
    const textOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return textOutput ? JSON.parse(textOutput) : null;
  }

  async _callWithApiKey(postText, locale, customPersona, apiKey, maxChars = 120, model = 'gemini-2.5-flash') {
    const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(apiKey);
    const prompt = this._buildPrompt(postText, locale, customPersona, maxChars);

    const res = await fetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.7 }
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
      err.status = res.status;
      throw err;
    }
    const textOutput = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return textOutput ? JSON.parse(textOutput) : null;
  }

  _generateHeuristic(postText, locale) {
    const lower = postText.toLowerCase();
    if (lower.includes('buon') || lower.includes('rip') || lower.includes('chia buon') || lower.includes('sad')) {
      return { reaction: 'CARE', shouldInteract: true, comment: '', reason: 'Empathy post' };
    }
    if (lower.includes('chuc mung') || lower.includes('congrats') || lower.includes('thanh cong')) {
      return {
        reaction: 'LOVE',
        shouldInteract: true,
        comment: locale === 'VN' ? 'Chúc mừng bạn nhé, quá xuất sắc!' : 'Congratulations! Well deserved!',
        reason: 'Celebration post'
      };
    }
    return {
      reaction: 'LIKE',
      shouldInteract: true,
      comment: locale === 'VN' ? 'Bài viết chia sẻ rất hữu ích, cảm ơn bạn!' : 'Great share, really appreciate the insights!',
      reason: 'General discussion post'
    };
  }
}

module.exports = { GeminiAdapter, DEFAULT_FLASH_MODELS };
