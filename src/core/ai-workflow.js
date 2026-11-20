/**
 * VTN Anti-Browser AI Workflow Builder & Self-Healing Automation (`src/core/ai-workflow.js`)
 * Compiles Vietnamese natural-language prompts into structured browser automation steps
 * (via `aiClient.generateJson` or an offline heuristic parser) and executes them over CDP
 * with automatic LLM-assisted selector self-healing when `click` or `type` fails.
 */

const {
  navigatePage,
  clickElement,
  typeText,
  scrollPage,
  getPageSnapshot,
  captureScreenshot
} = require('./cdp-controller');

const ALLOWED_ACTIONS = new Set([
  'goto',
  'wait',
  'click',
  'type',
  'scroll',
  'extract',
  'screenshot'
]);

const WORKFLOW_EXAMPLES = [
  {
    id: 'hackernews_digest',
    label: 'Đọc & trích xuất tin Hacker News',
    name: 'Trích xuất Hacker News',
    prompt:
      'Mở https://news.ycombinator.com/, chờ 2 giây, cuộn xuống 600px, trích xuất danh sách bài viết nổi bật và chụp ảnh màn hình.'
  },
  {
    id: 'wikipedia_overview',
    label: 'Mở Wikipedia & tóm tắt nội dung',
    name: 'Khảo sát trang Wikipedia',
    prompt:
      'Mở https://en.wikipedia.org/wiki/Artificial_intelligence, chờ 2 giây, cuộn xuống 800px, trích xuất nội dung chính và chụp ảnh màn hình.'
  },
  {
    id: 'bbc_tech_monitor',
    label: 'Theo dõi tin công nghệ BBC',
    name: 'Theo dõi BBC Innovation',
    prompt:
      'Mở https://www.bbc.com/innovation, chờ 3 giây, cuộn xuống 700px, trích xuất tiêu đề các bài viết và chụp ảnh màn hình.'
  }
];

function clampNumber(val, fallback, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
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

function normalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let candidate = raw.trim().replace(/[),.;]+$/, '');
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Validates and sanitizes a raw workflow step object into the canonical schema.
 */
function normalizeStep(rawStep) {
  if (!rawStep || typeof rawStep !== 'object') return null;
  const action = String(rawStep.action || '').trim().toLowerCase();
  if (!ALLOWED_ACTIONS.has(action)) return null;

  const description = typeof rawStep.description === 'string'
    ? rawStep.description.trim().slice(0, 200)
    : undefined;

  if (action === 'goto') {
    const url = normalizeUrl(rawStep.url);
    if (!url) return null;
    const step = { action: 'goto', url };
    if (rawStep.ms !== undefined) step.ms = Math.round(clampNumber(rawStep.ms, 2000, 200, 15000));
    if (description) step.description = description;
    return step;
  }

  if (action === 'wait') {
    const ms = Math.round(clampNumber(rawStep.ms, 1500, 100, 30000));
    const step = { action: 'wait', ms };
    if (description) step.description = description;
    return step;
  }

  if (action === 'click') {
    const selector = typeof rawStep.selector === 'string' ? rawStep.selector.trim() : '';
    if (!selector) return null;
    const step = { action: 'click', selector };
    if (description) step.description = description;
    return step;
  }

  if (action === 'type') {
    const selector = typeof rawStep.selector === 'string' ? rawStep.selector.trim() : '';
    if (!selector) return null;
    const step = {
      action: 'type',
      selector,
      text: String(rawStep.text ?? '')
    };
    if (rawStep.pressEnter) step.pressEnter = true;
    if (description) step.description = description;
    return step;
  }

  if (action === 'scroll') {
    const direction = String(rawStep.direction || 'down').toLowerCase() === 'up' ? 'up' : 'down';
    const amount = Math.round(clampNumber(rawStep.amount, 600, 50, 5000));
    const step = { action: 'scroll', direction, amount };
    if (description) step.description = description;
    return step;
  }

  if (action === 'extract') {
    const step = { action: 'extract' };
    if (description) step.description = description;
    return step;
  }

  if (action === 'screenshot') {
    const step = { action: 'screenshot' };
    if (description) step.description = description;
    return step;
  }

  return null;
}

/**
 * Offline heuristic parser for simple Vietnamese/English automation prompts.
 */
function parsePromptHeuristically(prompt) {
  const text = String(prompt || '').trim();
  const steps = [];

  // 1. Extract explicit http(s) URLs
  const urlMatches = text.match(/https?:\/\/[^\s,;"'<>]+/gi) || [];
  for (const rawUrl of urlMatches) {
    const url = normalizeUrl(rawUrl);
    if (url) {
      steps.push({ action: 'goto', url, description: `Mở trang ${url}` });
    }
  }

  // Fallback bare domain detection if no http(s) URL found
  if (steps.length === 0) {
    const domainMatch = text.match(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i);
    if (domainMatch) {
      const url = normalizeUrl(domainMatch[1]);
      if (url) {
        steps.push({ action: 'goto', url, description: `Mở trang ${url}` });
      }
    }
  }

  // 2. Wait cues: e.g. "chờ 3 giây", "đợi 1500ms", "wait 2s"
  const waitMatch = text.match(/(?:chờ|đợi|wait)\s*(\d+(?:\.\d+)?)\s*(ms|giây|s|sec)?/i);
  if (waitMatch) {
    const num = Number(waitMatch[1]);
    const unit = (waitMatch[2] || 's').toLowerCase();
    const ms = unit === 'ms' ? num : num * 1000;
    steps.push({
      action: 'wait',
      ms: Math.round(clampNumber(ms, 2000, 100, 30000)),
      description: `Chờ ${Math.round(clampNumber(ms, 2000, 100, 30000))}ms`
    });
  }

  // 3. Scroll cues: e.g. "cuộn xuống 800px", "scroll up"
  if (/(?:cuộn|scroll|lướt)/i.test(text)) {
    const isUp = /(?:cuộn\s+lên|scroll\s+up)/i.test(text);
    const pxMatch = text.match(/(?:cuộn|scroll)[^0-9]{0,20}(\d{2,4})\s*(?:px)?/i);
    const amount = pxMatch ? Math.round(clampNumber(pxMatch[1], 600, 50, 5000)) : 600;
    steps.push({
      action: 'scroll',
      direction: isUp ? 'up' : 'down',
      amount,
      description: isUp ? `Cuộn lên ${amount}px` : `Cuộn xuống ${amount}px`
    });
  }

  // 4. Extract cues
  if (/(?:trích\s*xuất|lấy\s*dữ\s*liệu|tóm\s*tắt|đọc\s*nội\s*dung|extract|snapshot)/i.test(text)) {
    steps.push({
      action: 'extract',
      description: 'Trích xuất nội dung và các phần tử trên trang'
    });
  }

  // 5. Screenshot cues
  if (/(?:chụp\s*ảnh|chụp\s*màn\s*hình|screenshot)/i.test(text)) {
    steps.push({
      action: 'screenshot',
      description: 'Chụp ảnh màn hình hiện tại'
    });
  }

  // Default fallback so the workflow is always runnable
  if (steps.length === 0) {
    steps.push({
      action: 'extract',
      description: 'Trích xuất nội dung trang hiện tại'
    });
    steps.push({
      action: 'screenshot',
      description: 'Chụp ảnh màn hình kiểm chứng'
    });
  }

  return steps;
}

/**
 * Compiles a Vietnamese/English automation prompt into a validated workflow definition.
 */
async function generateWorkflow({ aiClient = null, prompt, name } = {}) {
  const cleanPrompt = String(prompt ?? '').trim();
  if (!cleanPrompt) {
    throw new Error('Vui lòng nhập mô tả quy trình (prompt) để tạo workflow');
  }

  const fallbackName =
    (typeof name === 'string' && name.trim()) ||
    `Workflow ${cleanPrompt.slice(0, 36)}${cleanPrompt.length > 36 ? '...' : ''}`;

  const canUseLlm =
    aiClient &&
    typeof aiClient.isConfigured === 'function' &&
    aiClient.isConfigured() &&
    typeof aiClient.generateJson === 'function';

  if (canUseLlm) {
    try {
      const systemPrompt =
        'You are a browser automation compiler for VTN Anti-Browser. ' +
        'Convert the user instruction (Vietnamese or English) into a JSON object: ' +
        '{ "name": "Short Vietnamese workflow name", "steps": [ ... ] }. ' +
        'Allowed step schemas:\n' +
        '- { "action": "goto", "url": "https://...", "description": "..." }\n' +
        '- { "action": "wait", "ms": 2000, "description": "..." }\n' +
        '- { "action": "click", "selector": "CSS selector", "description": "..." }\n' +
        '- { "action": "type", "selector": "CSS selector", "text": "...", "pressEnter": false, "description": "..." }\n' +
        '- { "action": "scroll", "direction": "down"|"up", "amount": 600, "description": "..." }\n' +
        '- { "action": "extract", "description": "..." }\n' +
        '- { "action": "screenshot", "description": "..." }\n' +
        'Return strictly valid JSON with 1 to 15 concise, reliable steps.';

      const userPrompt = `User prompt:\n${cleanPrompt}`;

      const raw = await aiClient.generateJson({
        system: systemPrompt,
        systemPrompt,
        prompt: userPrompt,
        userPrompt,
        temperature: 0.2
      });

      const parsed = unwrapJsonResult(raw);
      const rawSteps = Array.isArray(parsed?.steps)
        ? parsed.steps
        : (Array.isArray(parsed) ? parsed : []);

      const validated = rawSteps.map(normalizeStep).filter(Boolean);
      if (validated.length > 0) {
        const resolvedName =
          (typeof name === 'string' && name.trim()) ||
          (typeof parsed?.name === 'string' && parsed.name.trim()) ||
          fallbackName;
        return {
          name: resolvedName,
          prompt: cleanPrompt,
          steps: validated,
          usedLlm: true
        };
      }
    } catch {
      // Fall through cleanly to offline heuristic parser
    }
  }

  const heuristicSteps = parsePromptHeuristically(cleanPrompt);
  return {
    name: fallbackName,
    prompt: cleanPrompt,
    steps: heuristicSteps,
    usedLlm: false
  };
}

/**
 * Attempts to self-heal a failed CSS selector using a live page snapshot and LLM reasoning.
 */
async function attemptSelfHeal({ debuggingPort, aiClient, step, errorMessage }) {
  const snapshot = await getPageSnapshot(debuggingPort, {
    maxTextChars: 2000,
    maxElements: 80
  });

  const interactiveElements = Array.isArray(snapshot?.interactiveElements)
    ? snapshot.interactiveElements
    : [];

  if (interactiveElements.length === 0) {
    return null;
  }

  const systemPrompt =
    'You are a Self-Healing CSS Selector assistant for browser automation. ' +
    'Given a failed step and the live page interactiveElements, pick the best replacement CSS selector from interactiveElements. ' +
    'Return strictly JSON: { "selector": "...", "reason": "short explanation" }. ' +
    'If no suitable element exists, return { "selector": null, "reason": "not found" }.';

  const userPrompt = JSON.stringify(
    {
      failedStep: {
        action: step.action,
        oldSelector: step.selector,
        text: step.text,
        description: step.description || ''
      },
      error: errorMessage,
      page: {
        url: snapshot.url,
        title: snapshot.title
      },
      interactiveElements
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

  const parsed = unwrapJsonResult(raw);
  const newSelector = typeof parsed?.selector === 'string' ? parsed.selector.trim() : '';
  if (!newSelector) return null;

  return {
    newSelector,
    reason: typeof parsed?.reason === 'string' ? parsed.reason.trim() : 'AI selector replacement'
  };
}

/**
 * Persists updated self-healed workflow steps to `db` when supported and `workflow.id` exists.
 */
function persistHealedWorkflow(db, workflow, updatedSteps) {
  if (!db || !workflow || !workflow.id) return false;
  try {
    const existing = typeof db.getWorkflow === 'function' ? db.getWorkflow(workflow.id) : null;
    const nextHealCount = (existing ? Number(existing.healCount) || 0 : Number(workflow.healCount) || 0) + 1;
    if (typeof db.saveWorkflow === 'function') {
      db.saveWorkflow({
        ...workflow,
        steps: updatedSteps,
        healCount: nextHealCount
      });
      return true;
    }
    if (typeof db.updateWorkflow === 'function') {
      db.updateWorkflow(workflow.id, { steps: updatedSteps, healCount: nextHealCount });
      return true;
    }
  } catch {
    // Non-fatal persistence error
  }
  return false;
}

/**
 * Executes a workflow on a target profile with optional LLM self-healing for click/type steps.
 */
async function runWorkflow({
  db = null,
  browserManager,
  aiClient = null,
  workflow,
  profileId,
  enableSelfHeal = true
} = {}) {
  const logs = [];
  const healedSteps = [];
  const extractedData = [];
  const screenshots = [];
  let stepsExecuted = 0;

  const log = (message) => {
    logs.push({ at: new Date().toISOString(), message: String(message) });
  };

  if (!browserManager) {
    return {
      ok: false,
      profileId: profileId ? String(profileId) : '',
      stepsExecuted: 0,
      healedSteps,
      extractedData,
      screenshots,
      logs,
      error: 'BrowserManager chưa được khởi tạo'
    };
  }

  const targetProfileId = String(profileId ?? '').trim();
  if (!targetProfileId) {
    return {
      ok: false,
      profileId: '',
      stepsExecuted: 0,
      healedSteps,
      extractedData,
      screenshots,
      logs,
      error: 'Thiếu profileId để thực thi workflow'
    };
  }

  const rawSteps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  const workingSteps = rawSteps.map(normalizeStep).filter(Boolean);
  if (workingSteps.length === 0) {
    return {
      ok: false,
      profileId: targetProfileId,
      stepsExecuted: 0,
      healedSteps,
      extractedData,
      screenshots,
      logs,
      error: 'Workflow không có bước hợp lệ nào để thực thi'
    };
  }

  try {
    // Ensure profile is open (or reuse running session)
    let debuggingPort = null;
    const existing = typeof browserManager.getSession === 'function'
      ? browserManager.getSession(targetProfileId)
      : null;

    if (existing && existing.debuggingPort) {
      debuggingPort = existing.debuggingPort;
      log(`Sử dụng phiên trình duyệt đang chạy của profile ${targetProfileId} (CDP port ${debuggingPort}).`);
    } else {
      log(`Đang mở trình duyệt cho profile ${targetProfileId}...`);
      const opened = await browserManager.openProfile(targetProfileId);
      debuggingPort = opened.debuggingPort;
      log(`Đã mở trình duyệt (CDP port ${debuggingPort}).`);
    }

    const canSelfHeal = Boolean(
      enableSelfHeal &&
      aiClient &&
      typeof aiClient.isConfigured === 'function' &&
      aiClient.isConfigured() &&
      typeof aiClient.generateJson === 'function'
    );

    for (let i = 0; i < workingSteps.length; i += 1) {
      const step = workingSteps[i];
      const label = `[Bước ${i + 1}/${workingSteps.length}] ${step.action}`;

      if (step.action === 'goto') {
        log(`${label}: Điều hướng tới ${step.url}`);
        const nav = await navigatePage(debuggingPort, step.url, { waitMs: step.ms || 2000 });
        log(`Đã tải "${nav.title || step.url}" (${nav.readyState}).`);
      } else if (step.action === 'wait') {
        const ms = clampNumber(step.ms, 1500, 100, 30000);
        log(`${label}: Chờ ${ms}ms`);
        await new Promise((r) => setTimeout(r, ms));
      } else if (step.action === 'scroll') {
        log(`${label}: Cuộn ${step.direction} ${step.amount}px`);
        await scrollPage(debuggingPort, {
          direction: step.direction,
          amount: step.amount
        });
      } else if (step.action === 'extract') {
        log(`${label}: Trích xuất dữ liệu trang`);
        const snap = await getPageSnapshot(debuggingPort);
        extractedData.push({
          stepIndex: i,
          description: step.description || '',
          url: snap.url,
          title: snap.title,
          textExcerpt: snap.textExcerpt,
          interactiveCount: Array.isArray(snap.interactiveElements) ? snap.interactiveElements.length : 0
        });
        log(`Đã trích xuất "${snap.title || snap.url}" (${(snap.textExcerpt || '').length} ký tự).`);
      } else if (step.action === 'screenshot') {
        log(`${label}: Chụp ảnh màn hình`);
        const shot = await captureScreenshot(debuggingPort, { format: 'png' });
        screenshots.push({
          stepIndex: i,
          description: step.description || '',
          mimeType: shot.mimeType,
          bytes: shot.bytes,
          base64: shot.base64
        });
        log(`Đã chụp ảnh (${shot.bytes} bytes).`);
      } else if (step.action === 'click' || step.action === 'type') {
        const runInteraction = async (selector) => {
          if (step.action === 'click') {
            return clickElement(debuggingPort, selector);
          }
          return typeText(debuggingPort, selector, step.text || '', {
            pressEnter: Boolean(step.pressEnter)
          });
        };

        log(`${label}: ${step.selector}`);
        try {
          await runInteraction(step.selector);
        } catch (firstErr) {
          if (!canSelfHeal) {
            throw firstErr;
          }
          log(`Thao tác thất bại (${firstErr.message}). Đang kích hoạt AI Self-Healing...`);
          const healed = await attemptSelfHeal({
            debuggingPort,
            aiClient,
            step,
            errorMessage: firstErr.message
          });

          if (!healed || !healed.newSelector) {
            throw new Error(`Self-Healing không tìm thấy selector thay thế cho "${step.selector}": ${firstErr.message}`);
          }

          log(`AI đề xuất selector mới: ${healed.newSelector} (${healed.reason}). Đang thử lại...`);
          await runInteraction(healed.newSelector);

          const oldSelector = step.selector;
          step.selector = healed.newSelector;
          healedSteps.push({
            stepIndex: i,
            oldSelector,
            newSelector: healed.newSelector
          });

          const saved = persistHealedWorkflow(db, workflow, workingSteps);
          log(
            saved
              ? `Self-Healing thành công và đã cập nhật workflow vào cơ sở dữ liệu.`
              : `Self-Healing thành công cho bước ${i + 1}.`
          );
        }
      }

      stepsExecuted += 1;
    }

    log(`Hoàn tất thực thi workflow (${stepsExecuted}/${workingSteps.length} bước).`);
    return {
      ok: true,
      profileId: targetProfileId,
      stepsExecuted,
      healedSteps,
      extractedData,
      screenshots,
      logs,
      error: null
    };
  } catch (err) {
    const message = err?.message || String(err);
    log(`Lỗi thực thi workflow: ${message}`);
    return {
      ok: false,
      profileId: targetProfileId,
      stepsExecuted,
      healedSteps,
      extractedData,
      screenshots,
      logs,
      error: message
    };
  }
}

module.exports = {
  WORKFLOW_EXAMPLES,
  generateWorkflow,
  runWorkflow
};
