/**
 * VTN Anti-Browser AI Account Warming (`src/core/ai-warmer.js`)
 * Zero-dependency natural browsing & cookie-warming orchestrator built on `./cdp-controller`.
 * Generates persona-driven browsing plans via `aiClient.generateJson` (with safe public fallbacks
 * when offline), opens profiles on demand, navigates naturally, dwells, and scrolls.
 */

const crypto = require('crypto');
const { navigatePage, scrollPage } = require('./cdp-controller');

const MAX_CONCURRENT_JOBS = 5;
const MAX_RETAINED_JOBS = 50;

const DEFAULT_FALLBACK_URLS = [
  'https://en.wikipedia.org/wiki/Main_Page',
  'https://news.ycombinator.com/',
  'https://www.bbc.com/news',
  'https://www.reuters.com/',
  'https://en.wikipedia.org/wiki/Technology',
  'https://en.wikipedia.org/wiki/World_Wide_Web'
];

const WARMING_PRESETS = [
  {
    id: 'us_tech_shopper',
    label: 'Khách mua sắm Công nghệ Mỹ (US Tech Shopper)',
    persona:
      'Người tiêu dùng Mỹ 28-35 tuổi yêu thích công nghệ, thường xuyên đọc tin tức phần cứng, so sánh giá laptop/điện thoại và xem đánh giá sản phẩm trước khi mua.',
    language: 'en-US',
    fallbackUrls: [
      'https://news.ycombinator.com/',
      'https://en.wikipedia.org/wiki/Consumer_electronics',
      'https://www.theverge.com/',
      'https://arstechnica.com/',
      'https://www.bbc.com/innovation',
      'https://en.wikipedia.org/wiki/Laptop'
    ]
  },
  {
    id: 'ecom_seller',
    label: 'Nhà bán hàng Thương mại Điện tử (E-com Seller)',
    persona:
      'Chủ shop TMĐT đa kênh (Amazon/Etsy/Shopify), thường đọc tin tức kinh doanh, xu hướng logistics, quảng cáo số và nghiên cứu thị trường toàn cầu.',
    language: 'en-US',
    fallbackUrls: [
      'https://en.wikipedia.org/wiki/E-commerce',
      'https://www.bbc.com/business',
      'https://www.shopify.com/blog',
      'https://news.ycombinator.com/',
      'https://en.wikipedia.org/wiki/Digital_marketing',
      'https://en.wikipedia.org/wiki/Supply_chain_management'
    ]
  },
  {
    id: 'gaming_entertainment',
    label: 'Game thủ & Giải trí Quốc tế (Gaming & Entertainment)',
    persona:
      'Người dùng trẻ 20-28 tuổi đam mê game PC/Esports, phim ảnh và tin tức giải trí, hay lướt đọc tin game, wiki trò chơi và các trang giải trí phổ biến.',
    language: 'en-US',
    fallbackUrls: [
      'https://en.wikipedia.org/wiki/Video_game',
      'https://www.ign.com/',
      'https://www.pcgamer.com/',
      'https://www.bbc.com/culture',
      'https://en.wikipedia.org/wiki/Esports',
      'https://en.wikipedia.org/wiki/Film'
    ]
  }
];

function clampNumber(val, fallback, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function isSafePublicUrl(raw) {
  if (!raw || typeof raw !== 'string') return false;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host.endsWith('.local') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Sleeps in short increments so cancellation is responsive.
 */
async function interruptibleSleep(ms, isCancelledFn) {
  const total = Math.max(0, Math.round(ms));
  const slice = 250;
  let elapsed = 0;
  while (elapsed < total) {
    if (isCancelledFn()) return false;
    const wait = Math.min(slice, total - elapsed);
    await new Promise((r) => setTimeout(r, wait));
    elapsed += wait;
  }
  return !isCancelledFn();
}

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

class AiAccountWarmer {
  /**
   * @param {Object} deps
   * @param {Object} [deps.db]
   * @param {Object} deps.browserManager
   * @param {Object} [deps.aiClient]
   */
  constructor({ db = null, browserManager = null, aiClient = null } = {}) {
    this.db = db;
    this.browserManager = browserManager;
    this.aiClient = aiClient;
    /** @type {Map<string, Object>} */
    this.jobs = new Map();
  }

  _appendLog(job, message) {
    const entry = {
      at: new Date().toISOString(),
      message: String(message)
    };
    job.logs.push(entry);
    if (job.logs.length > 100) {
      job.logs.shift();
    }
  }

  _serializeJob(job) {
    return {
      jobId: job.jobId,
      profileId: job.profileId,
      profileName: job.profileName,
      status: job.status,
      persona: job.persona,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      stepsCompleted: job.stepsCompleted,
      totalSteps: job.totalSteps,
      logs: job.logs.map((l) => ({ ...l }))
    };
  }

  _pruneOldJobs() {
    if (this.jobs.size <= MAX_RETAINED_JOBS) return;
    const finished = Array.from(this.jobs.values())
      .filter((j) => j.status !== 'running')
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    while (this.jobs.size > MAX_RETAINED_JOBS && finished.length > 0) {
      const oldest = finished.shift();
      this.jobs.delete(oldest.jobId);
    }
  }

  /**
   * Returns active and recent warming jobs sorted newest first.
   */
  getStatus() {
    return Array.from(this.jobs.values())
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map((job) => this._serializeJob(job));
  }

  /**
   * Starts asynchronous AI warming jobs for 1..5 profiles.
   */
  startWarming({ profileIds, persona, presetId, durationMinutes = 3, maxSteps = 4 } = {}) {
    if (!this.browserManager) {
      throw new Error('BrowserManager chưa được khởi tạo cho AiAccountWarmer');
    }
    if (!Array.isArray(profileIds) || profileIds.length === 0) {
      throw new Error('Vui lòng chọn ít nhất 1 profile hợp lệ để nuôi tài khoản');
    }

    const cleanIds = [];
    const seen = new Set();
    for (const rawId of profileIds) {
      const id = String(rawId ?? '').trim();
      if (!id) continue;
      if (!seen.has(id)) {
        seen.add(id);
        cleanIds.push(id);
      }
    }

    if (cleanIds.length === 0) {
      throw new Error('Danh sách profileIds không chứa ID hợp lệ');
    }
    if (cleanIds.length > MAX_CONCURRENT_JOBS) {
      throw new Error(`Chỉ hỗ trợ chạy tối đa ${MAX_CONCURRENT_JOBS} profile cùng lúc`);
    }

    const activeJobs = Array.from(this.jobs.values()).filter((j) => j.status === 'running');
    if (activeJobs.length + cleanIds.length > MAX_CONCURRENT_JOBS) {
      throw new Error(
        `Đang có ${activeJobs.length} phiên warming hoạt động. Tổng số phiên đồng thời không được vượt quá ${MAX_CONCURRENT_JOBS}`
      );
    }

    const preset = presetId
      ? WARMING_PRESETS.find((p) => p.id === String(presetId).trim()) || null
      : null;

    const effectivePersona =
      (typeof persona === 'string' && persona.trim()) ||
      (preset ? preset.persona : WARMING_PRESETS[0].persona);

    const safeDuration = clampNumber(durationMinutes, 3, 0.5, 30);
    const safeMaxSteps = Math.round(clampNumber(maxSteps, 4, 1, 10));

    const createdJobs = [];

    for (const profileId of cleanIds) {
      const profile = this.db && typeof this.db.getProfile === 'function'
        ? this.db.getProfile(profileId)
        : null;
      const profileName = profile ? profile.name : profileId;

      const job = {
        jobId: `warm_${crypto.randomBytes(4).toString('hex')}`,
        profileId,
        profileName,
        status: 'running',
        persona: effectivePersona,
        presetId: preset ? preset.id : null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        stepsCompleted: 0,
        totalSteps: safeMaxSteps,
        logs: [],
        cancelled: false,
        openedByWarmer: false
      };

      this._appendLog(job, `Khởi tạo phiên warming cho profile "${profileName}" (${safeMaxSteps} bước).`);
      this.jobs.set(job.jobId, job);
      createdJobs.push(job);

      // Fire-and-forget background task with guaranteed error containment
      this._runWarmingJob(job, {
        preset,
        durationMinutes: safeDuration,
        maxSteps: safeMaxSteps
      }).catch((err) => {
        job.status = 'error';
        job.finishedAt = new Date().toISOString();
        this._appendLog(job, `Lỗi không mong muốn: ${err?.message || String(err)}`);
      });
    }

    this._pruneOldJobs();

    return {
      ok: true,
      started: createdJobs.length,
      jobs: createdJobs.map((j) => this._serializeJob(j))
    };
  }

  /**
   * Requests graceful cancellation of a single warming job.
   */
  stopWarming(jobId) {
    const id = String(jobId ?? '').trim();
    const job = this.jobs.get(id);
    if (!job) {
      return { ok: false, error: `Không tìm thấy job warming: ${id}` };
    }
    if (job.status === 'running') {
      job.cancelled = true;
      this._appendLog(job, 'Đã nhận lệnh dừng phiên warming.');
    }
    return { ok: true, job: this._serializeJob(job) };
  }

  /**
   * Requests graceful cancellation of all currently running warming jobs.
   */
  stopAll() {
    let stoppedCount = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && !job.cancelled) {
        job.cancelled = true;
        this._appendLog(job, 'Đã nhận lệnh dừng tất cả phiên warming.');
        stoppedCount += 1;
      }
    }
    return { ok: true, stoppedCount };
  }

  async _buildBrowsingPlan(job, { preset, durationMinutes, maxSteps }) {
    const targetSteps = clampNumber(maxSteps, 4, 1, 6);
    const defaultDwellSec = Math.round(
      clampNumber((durationMinutes * 60) / Math.max(targetSteps, 1) * 0.25, 3, 2, 6)
    );

    const buildFallback = () => {
      const pool = (preset && Array.isArray(preset.fallbackUrls) && preset.fallbackUrls.length > 0)
        ? preset.fallbackUrls
        : DEFAULT_FALLBACK_URLS;
      return pool.slice(0, targetSteps).map((url) => ({
        url,
        scrollCount: randomInt(1, 2),
        dwellSeconds: defaultDwellSec
      }));
    };

    const canUseLlm =
      this.aiClient &&
      typeof this.aiClient.isConfigured === 'function' &&
      this.aiClient.isConfigured() &&
      typeof this.aiClient.generateJson === 'function';

    if (!canUseLlm) {
      this._appendLog(job, 'AI chưa cấu hình — sử dụng danh sách URL an toàn mặc định.');
      return buildFallback();
    }

    try {
      this._appendLog(job, 'Đang nhờ AI lập kế hoạch lướt web tự nhiên theo persona...');
      const systemPrompt =
        'You generate realistic, safe, public web browsing plans for browser profile warming. ' +
        'Return strictly JSON matching: { "steps": [ { "url": "https://...", "scrollCount": 1, "dwellSeconds": 3 } ] }. ' +
        'Rules: 3 to 6 public HTTPS URLs (Wikipedia, news, tech blogs, shopping info, public portals). ' +
        'Never output localhost, private IPs, login pages, or unsafe sites. scrollCount must be 1 or 2. dwellSeconds must be 2 to 6.';

      const userPrompt =
        `Persona: ${job.persona}\n` +
        `Language: ${preset?.language || 'en-US'}\n` +
        `Requested step count: ${targetSteps}\n` +
        `Return JSON with "steps" array.`;

      const raw = await this.aiClient.generateJson({
        system: systemPrompt,
        systemPrompt,
        prompt: userPrompt,
        userPrompt,
        temperature: 0.7
      });

      const parsed = unwrapJsonResult(raw);
      const rawSteps = Array.isArray(parsed?.steps)
        ? parsed.steps
        : (Array.isArray(parsed) ? parsed : []);

      const sanitized = [];
      for (const item of rawSteps) {
        if (!item || !isSafePublicUrl(item.url)) continue;
        sanitized.push({
          url: String(item.url).trim(),
          scrollCount: Math.round(clampNumber(item.scrollCount, randomInt(1, 2), 1, 2)),
          dwellSeconds: Math.round(clampNumber(item.dwellSeconds, defaultDwellSec, 2, 6))
        });
        if (sanitized.length >= targetSteps) break;
      }

      if (sanitized.length > 0) {
        this._appendLog(job, `AI đã tạo kế hoạch gồm ${sanitized.length} điểm đến an toàn.`);
        return sanitized;
      }

      this._appendLog(job, 'AI không trả về URL hợp lệ — chuyển sang danh sách fallback.');
      return buildFallback();
    } catch (err) {
      this._appendLog(job, `Không gọi được AI (${err?.message || 'lỗi'}), dùng danh sách fallback.`);
      return buildFallback();
    }
  }

  async _ensureProfileOpen(job) {
    const existing = typeof this.browserManager.getSession === 'function'
      ? this.browserManager.getSession(job.profileId)
      : null;

    if (existing && existing.debuggingPort) {
      job.openedByWarmer = false;
      this._appendLog(job, `Dùng lại trình duyệt đang mở (CDP port ${existing.debuggingPort}).`);
      return existing.debuggingPort;
    }

    this._appendLog(job, 'Đang khởi chạy trình duyệt cho profile...');
    const launchResult = await this.browserManager.openProfile(job.profileId);
    job.openedByWarmer = !launchResult.alreadyRunning;
    this._appendLog(job, `Trình duyệt đã sẵn sàng (CDP port ${launchResult.debuggingPort}).`);
    return launchResult.debuggingPort;
  }

  async _runWarmingJob(job, opts) {
    try {
      const plan = await this._buildBrowsingPlan(job, opts);
      job.totalSteps = plan.length;

      if (job.cancelled) {
        job.status = 'stopped';
        job.finishedAt = new Date().toISOString();
        this._appendLog(job, 'Phiên warming đã dừng trước khi mở trình duyệt.');
        return;
      }

      const debuggingPort = await this._ensureProfileOpen(job);

      for (let i = 0; i < plan.length; i += 1) {
        if (job.cancelled) break;
        const step = plan[i];
        const stepNum = i + 1;

        this._appendLog(job, `[Bước ${stepNum}/${plan.length}] Truy cập ${step.url}`);
        try {
          const nav = await navigatePage(debuggingPort, step.url, { waitMs: 2000 });
          this._appendLog(job, `Đã tải: "${nav.title || step.url}"`);
        } catch (navErr) {
          this._appendLog(job, `Bỏ qua URL lỗi (${step.url}): ${navErr?.message || 'navigation failed'}`);
          job.stepsCompleted = stepNum;
          continue;
        }

        if (job.cancelled) break;

        // Short natural dwell (capped cleanly at 6s so stop requests stay snappy)
        const dwellMs = clampNumber(step.dwellSeconds, 3, 1.5, 6) * 1000;
        const keptGoing = await interruptibleSleep(dwellMs, () => job.cancelled);
        if (!keptGoing) break;

        const scrolls = Math.round(clampNumber(step.scrollCount, 1, 1, 2));
        for (let s = 0; s < scrolls; s += 1) {
          if (job.cancelled) break;
          const amount = randomInt(320, 780);
          try {
            await scrollPage(debuggingPort, { direction: 'down', amount });
            this._appendLog(job, `Cuộn trang lần ${s + 1}/${scrolls} (${amount}px).`);
          } catch (scrollErr) {
            this._appendLog(job, `Cảnh báo cuộn trang: ${scrollErr?.message || 'scroll error'}`);
          }
          const ok = await interruptibleSleep(randomInt(700, 1400), () => job.cancelled);
          if (!ok) break;
        }

        job.stepsCompleted = stepNum;
      }

      if (job.cancelled) {
        job.status = 'stopped';
        this._appendLog(job, `Đã dừng phiên warming sau ${job.stepsCompleted}/${job.totalSteps} bước.`);
      } else {
        job.status = 'completed';
        this._appendLog(job, `Hoàn tất warming (${job.stepsCompleted}/${job.totalSteps} bước).`);
      }
      job.finishedAt = new Date().toISOString();
    } catch (err) {
      job.status = 'error';
      job.finishedAt = new Date().toISOString();
      this._appendLog(job, `Lỗi phiên warming: ${err?.message || String(err)}`);
    }
  }
}

module.exports = {
  WARMING_PRESETS,
  AiAccountWarmer
};
