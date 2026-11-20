/**
 * VTN Anti-Browser Unified CDP Controller (`src/core/cdp-controller.js`)
 * Zero-dependency Chrome DevTools Protocol client using Node.js >= 22 built-in WebSocket.
 * Shared foundation for Antidetect MCP Server, AI Account Warming, Self-Healing Workflows,
 * and Multi-Profile Visual Extractor.
 */

const { fetchCdpJson } = require('./browser-manager');

/**
 * Safely parses and clamps a numeric parameter, returning `fallback` for non-finite inputs.
 */
function clampNumber(val, fallback, min, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

/**
 * Resolves an inspectable page target WebSocket URL on the given CDP debugging port.
 *
 * @param {number} debuggingPort
 * @param {number} [targetIndex=0]
 * @returns {Promise<Object>}
 */
async function resolvePageTarget(debuggingPort, targetIndex = 0) {
  const targets = await fetchCdpJson(debuggingPort, '/json', 2500);
  const pages = Array.isArray(targets)
    ? targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    : [];
  if (pages.length === 0) {
    throw new Error(`No inspectable page target found on CDP port ${debuggingPort}`);
  }
  const idx = Math.max(0, Math.min(Number(targetIndex) || 0, pages.length - 1));
  return pages[idx];
}

/**
 * Lists all open page targets for a running profile.
 *
 * @param {number} debuggingPort
 * @returns {Promise<Array<Object>>}
 */
async function listPages(debuggingPort) {
  const targets = await fetchCdpJson(debuggingPort, '/json', 2500);
  if (!Array.isArray(targets)) return [];
  return targets
    .filter((t) => t.type === 'page')
    .map((t, index) => ({
      index,
      id: t.id,
      title: t.title || '',
      url: t.url || ''
    }));
}

/**
 * Executes a callback with a managed, auto-closing CDP WebSocket connection.
 *
 * @param {number} debuggingPort
 * @param {(send: (method: string, params?: Object) => Promise<Object>, target: Object) => Promise<any>} fn
 * @param {Object} [options={}]
 * @returns {Promise<any>}
 */
async function withCdpPage(debuggingPort, fn, options = {}) {
  const timeoutMs = clampNumber(options.timeoutMs, 15000, 1000, 120000);
  const target = await resolvePageTarget(debuggingPort, options.targetIndex || 0);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let nextId = 1;
    let settled = false;
    const pending = new Map();

    const cleanup = () => {
      clearTimeout(globalTimer);
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
      }
      pending.clear();
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {
        // Ignore close errors
      }
    };

    const failAll = (err) => {
      if (settled) return;
      settled = true;
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      pending.clear();
      cleanup();
      reject(err);
    };

    const globalTimer = setTimeout(() => {
      failAll(new Error(`CDP operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const send = (method, params = {}, cmdTimeoutMs = Math.min(timeoutMs, 10000)) => {
      return new Promise((resCmd, rejCmd) => {
        if (ws.readyState !== WebSocket.OPEN) {
          return rejCmd(new Error('CDP WebSocket is not open'));
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejCmd(new Error(`CDP command "${method}" timed out`));
        }, cmdTimeoutMs);

        pending.set(id, { resolve: resCmd, reject: rejCmd, timer });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (sendErr) {
          clearTimeout(timer);
          pending.delete(id);
          rejCmd(sendErr);
        }
      });
    };

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id && pending.has(msg.id)) {
          const entry = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) {
            entry.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          } else {
            entry.resolve(msg.result || {});
          }
        }
      } catch {
        // Ignore non-JSON frames
      }
    });

    ws.addEventListener('error', (err) => {
      failAll(new Error(`CDP WebSocket error: ${err.message || 'connection failed'}`));
    });

    ws.addEventListener('close', () => {
      if (!settled) {
        failAll(new Error('CDP WebSocket closed unexpectedly'));
      }
    });

    ws.addEventListener('open', async () => {
      try {
        const result = await fn(send, target);
        if (!settled) {
          settled = true;
          cleanup();
          resolve(result);
        }
      } catch (err) {
        failAll(err);
      }
    });
  });
}

/**
 * Helper to evaluate a JS expression inside a CDP session and unwrap its return value.
 */
async function evalInSession(send, expression, awaitPromise = true) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise
  });
  if (res.exceptionDetails) {
    const desc =
      res.exceptionDetails.exception?.description ||
      res.exceptionDetails.text ||
      'JavaScript evaluation exception';
    throw new Error(desc);
  }
  return res.result ? res.result.value : undefined;
}

/**
 * Navigates the active page to the given URL and waits briefly for initial load.
 */
async function navigatePage(debuggingPort, url, options = {}) {
  const waitMs = clampNumber(options.waitMs, 2500, 200, 15000);
  const parsed = new URL(url);
  if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  return withCdpPage(
    debuggingPort,
    async (send) => {
      await send('Page.enable');
      const navResult = await send('Page.navigate', { url: parsed.href });
      if (navResult.errorText) {
        throw new Error(`Navigation failed: ${navResult.errorText}`);
      }
      await new Promise((r) => setTimeout(r, waitMs));
      const meta = await evalInSession(
        send,
        `({ url: location.href, title: document.title, readyState: document.readyState })`
      );
      return {
        navigatedTo: parsed.href,
        currentUrl: meta?.url || parsed.href,
        title: meta?.title || '',
        readyState: meta?.readyState || 'unknown'
      };
    },
    { timeoutMs: waitMs + 10000, targetIndex: options.targetIndex }
  );
}

/**
 * Captures a compact, LLM-friendly snapshot of the current page:
 * URL, title, readable text excerpt, and interactive elements with reliable CSS selectors.
 */
async function getPageSnapshot(debuggingPort, options = {}) {
  const maxTextChars = clampNumber(options.maxTextChars, 4000, 500, 20000);
  const maxElements = clampNumber(options.maxElements, 60, 10, 150);

  const expr = `(() => {
    const cssEscape = (str) => {
      if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(str);
      return String(str).replace(/([ #;?%&,.+*~':"!^$\\[\\]()=>|/@])/g, '\\\\$1');
    };
    const escapeAttrVal = (val) => String(val).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');

    const buildSelector = (el) => {
      if (el.id) return '#' + cssEscape(el.id);
      const dataTestId = el.getAttribute('data-testid');
      if (dataTestId) return '[data-testid="' + escapeAttrVal(dataTestId) + '"]';
      const dataTest = el.getAttribute('data-test');
      if (dataTest) return '[data-test="' + escapeAttrVal(dataTest) + '"]';
      const name = el.getAttribute('name');
      if (name && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
        return el.tagName.toLowerCase() + '[name="' + escapeAttrVal(name) + '"]';
      }
      const aria = el.getAttribute('aria-label');
      if (aria && aria.length < 60) {
        return el.tagName.toLowerCase() + '[aria-label="' + escapeAttrVal(aria) + '"]';
      }
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 4) {
        let part = cur.tagName.toLowerCase();
        if (cur.id) {
          parts.unshift('#' + cssEscape(cur.id));
          break;
        }
        const parent = cur.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
          if (sameTag.length > 1) {
            part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
          }
        }
        parts.unshift(part);
        cur = parent;
      }
      return parts.join(' > ');
    };

    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity || '1') > 0;
    };

    const nodes = Array.from(
      document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]')
    );

    const interactiveElements = [];
    for (const el of nodes) {
      if (interactiveElements.length >= ${maxElements}) break;
      if (!isVisible(el)) continue;
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim();
      interactiveElements.push({
        index: interactiveElements.length + 1,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        text: text.slice(0, 100),
        placeholder: el.getAttribute('placeholder') || undefined,
        href: el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 200) : undefined,
        selector: buildSelector(el)
      });
    }

    const rawText = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
    return {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight, scrollY: window.scrollY },
      textExcerpt: rawText.slice(0, ${maxTextChars}),
      totalTextLength: rawText.length,
      interactiveElements
    };
  })()`;

  return withCdpPage(
    debuggingPort,
    async (send) => evalInSession(send, expr),
    { timeoutMs: 10000, targetIndex: options.targetIndex }
  );
}

/**
 * Clicks an element matched by CSS selector (scrolls into view first).
 */
async function clickElement(debuggingPort, selector, options = {}) {
  if (!selector || typeof selector !== 'string') {
    throw new Error('Missing CSS selector for click');
  }
  const safeSel = JSON.stringify(selector);
  const expr = `(() => {
    const el = document.querySelector(${safeSel});
    if (!el) return { ok: false, error: 'Element not found for selector: ' + ${safeSel} };
    el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    el.focus?.();
    el.click();
    return {
      ok: true,
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.value || '').trim().slice(0, 100),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };
  })()`;

  return withCdpPage(
    debuggingPort,
    async (send) => {
      const result = await evalInSession(send, expr);
      if (!result || !result.ok) {
        throw new Error(result?.error || `Click failed for selector: ${selector}`);
      }
      return result;
    },
    { timeoutMs: 10000, targetIndex: options.targetIndex }
  );
}

/**
 * Types text into an input/textarea/contenteditable element and dispatches standard DOM events.
 */
async function typeText(debuggingPort, selector, text, options = {}) {
  if (!selector || typeof selector !== 'string') {
    throw new Error('Missing CSS selector for type');
  }
  const clear = options.clear !== false;
  const pressEnter = Boolean(options.pressEnter);
  const safeSel = JSON.stringify(selector);
  const safeText = JSON.stringify(String(text ?? ''));

  const expr = `(() => {
    const el = document.querySelector(${safeSel});
    if (!el) return { ok: false, error: 'Element not found for selector: ' + ${safeSel} };
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus();

    if (el.isContentEditable) {
      if (${clear}) el.innerText = '';
      el.innerText = (${clear} ? '' : el.innerText) + ${safeText};
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${safeText} }));
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const nextVal = (${clear} ? '' : (el.value || '')) + ${safeText};
      if (setter) setter.call(el, nextVal);
      else el.value = nextVal;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      return { ok: false, error: 'Element is not an editable input, textarea, or contenteditable: ' + el.tagName.toLowerCase() };
    }

    if (${pressEnter}) {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      if (el.form && typeof el.form.requestSubmit === 'function') {
        el.form.requestSubmit();
      }
    }

    return { ok: true, tag: el.tagName.toLowerCase(), length: ${safeText}.length, pressEnter: ${pressEnter} };
  })()`;

  return withCdpPage(
    debuggingPort,
    async (send) => {
      const result = await evalInSession(send, expr);
      if (!result || !result.ok) {
        throw new Error(result?.error || `Type failed for selector: ${selector}`);
      }
      return result;
    },
    { timeoutMs: 10000, targetIndex: options.targetIndex }
  );
}

/**
 * Scrolls the current page vertically.
 */
async function scrollPage(debuggingPort, options = {}) {
  const direction = options.direction === 'up' ? -1 : 1;
  const amount = clampNumber(options.amount, 600, 50, 5000);
  const deltaY = direction * amount;

  const expr = `(() => {
    window.scrollBy({ top: ${deltaY}, behavior: 'smooth' });
    return {
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight
    };
  })()`;

  return withCdpPage(
    debuggingPort,
    async (send) => evalInSession(send, expr),
    { timeoutMs: 8000, targetIndex: options.targetIndex }
  );
}

/**
 * Evaluates an arbitrary JavaScript expression inside the active page.
 */
async function evaluateScript(debuggingPort, expression, options = {}) {
  if (!expression || typeof expression !== 'string') {
    throw new Error('Missing JavaScript expression');
  }
  return withCdpPage(
    debuggingPort,
    async (send) => evalInSession(send, expression, options.awaitPromise !== false),
    { timeoutMs: clampNumber(options.timeoutMs, 12000, 1000, 60000), targetIndex: options.targetIndex }
  );
}

/**
 * Captures a screenshot of the active page via CDP and returns base64 image data.
 */
async function captureScreenshot(debuggingPort, options = {}) {
  const format = options.format === 'jpeg' ? 'jpeg' : 'png';
  const quality = format === 'jpeg' ? clampNumber(options.quality, 80, 30, 100) : undefined;
  const fullPage = Boolean(options.fullPage);

  return withCdpPage(
    debuggingPort,
    async (send) => {
      await send('Page.enable');
      const params = { format, captureBeyondViewport: fullPage };
      if (quality !== undefined) params.quality = quality;
      const result = await send('Page.captureScreenshot', params, 12000);
      if (!result || !result.data) {
        throw new Error('CDP Page.captureScreenshot returned empty data');
      }
      return {
        format,
        mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        base64: result.data,
        bytes: Buffer.from(result.data, 'base64').length
      };
    },
    { timeoutMs: 15000, targetIndex: options.targetIndex }
  );
}

/**
 * Opens a new browser tab via CDP `Target.createTarget` with URL protocol validation.
 */
async function newTab(debuggingPort, url = 'about:blank') {
  const rawUrl = (url && typeof url === 'string' && url.trim()) ? url.trim() : 'about:blank';
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL for newTab: ${rawUrl}`);
  }
  if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  }

  return withCdpPage(
    debuggingPort,
    async (send) => {
      const res = await send('Target.createTarget', { url: parsed.href });
      return {
        targetId: res.targetId || null,
        url: parsed.href
      };
    },
    { timeoutMs: 10000 }
  );
}

/**
 * Closes a tab by `targetId` or `targetIndex`. Refuses to close if only 1 page remains.
 */
async function closeTab(debuggingPort, { targetIndex, targetId } = {}) {
  const targets = await fetchCdpJson(debuggingPort, '/json', 2500);
  const pages = Array.isArray(targets)
    ? targets.filter((t) => t.type === 'page')
    : [];
  if (pages.length <= 1) {
    throw new Error('Cannot close the last remaining tab. Use vtn_close_profile to close the browser.');
  }

  let target = null;
  if (targetId !== undefined && targetId !== null && String(targetId).trim() !== '') {
    const wantedId = String(targetId).trim();
    target = pages.find((p) => p.id === wantedId) || null;
    if (!target) {
      throw new Error(`Tab not found for targetId: ${wantedId}`);
    }
  } else {
    const rawIdx = targetIndex === undefined ? 0 : targetIndex;
    if (typeof rawIdx === 'boolean' || rawIdx === null || rawIdx === '') {
      throw new Error(`Invalid targetIndex ${targetIndex}: must be an integer between 0 and ${pages.length - 1}`);
    }
    const idx = Number(rawIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pages.length) {
      throw new Error(`Invalid targetIndex ${targetIndex}: must be an integer between 0 and ${pages.length - 1}`);
    }
    target = pages[idx];
  }

  // Connect to a different inspectable page so the WebSocket stays open while closing the target tab
  const inspectablePages = pages.filter((p) => p.webSocketDebuggerUrl);
  const hostIndex = inspectablePages.findIndex((p) => p.id !== target.id);
  return withCdpPage(
    debuggingPort,
    async (send) => {
      const res = await send('Target.closeTarget', { targetId: target.id });
      if (res && res.success === false) {
        throw new Error(`Failed to close tab ${target.id}`);
      }
      return {
        closed: true,
        targetId: target.id
      };
    },
    { timeoutMs: 10000, targetIndex: hostIndex >= 0 ? hostIndex : 0 }
  );
}

/**
 * Polls `document.querySelector(selector)` until an element matches or timeout expires.
 */
async function waitForSelector(debuggingPort, selector, { timeoutMs = 10000, pollMs = 250, targetIndex = 0 } = {}) {
  if (!selector || typeof selector !== 'string') {
    throw new Error('Missing CSS selector for waitForSelector');
  }
  const safeTimeout = clampNumber(timeoutMs, 10000, 500, 60000);
  const safePoll = clampNumber(pollMs, 250, 50, 2000);
  const safeSel = JSON.stringify(selector);

  return withCdpPage(
    debuggingPort,
    async (send) => {
      const start = Date.now();
      while (true) {
        const found = await evalInSession(send, `Boolean(document.querySelector(${safeSel}))`, false);
        if (found) {
          return {
            found: true,
            selector,
            elapsedMs: Date.now() - start
          };
        }
        const elapsed = Date.now() - start;
        if (elapsed >= safeTimeout) {
          throw new Error(`Timed out after ${safeTimeout}ms waiting for selector: ${selector}`);
        }
        const remaining = safeTimeout - elapsed;
        await new Promise((r) => setTimeout(r, Math.min(safePoll, remaining)));
      }
    },
    { timeoutMs: safeTimeout + 5000, targetIndex }
  );
}

const KEY_DEFINITIONS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' }
};

/**
 * Dispatches a keyboard press via CDP `Input.dispatchKeyEvent`.
 */
async function pressKey(debuggingPort, key, { targetIndex = 0 } = {}) {
  if (!key || typeof key !== 'string') {
    throw new Error('Missing key for pressKey');
  }
  let def = KEY_DEFINITIONS[key];
  if (!def) {
    if (key.length === 1) {
      const isAlphaNum = /^[a-zA-Z0-9]$/.test(key);
      const vk = isAlphaNum ? key.toUpperCase().charCodeAt(0) : 0;
      let code;
      if (/^[a-zA-Z]$/.test(key)) code = `Key${key.toUpperCase()}`;
      else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
      def = {
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        text: key
      };
    } else {
      throw new Error(`Unsupported key "${key}". Use Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, Space, or a single character.`);
    }
  }

  return withCdpPage(
    debuggingPort,
    async (send) => {
      const base = {
        key: def.key,
        windowsVirtualKeyCode: def.windowsVirtualKeyCode,
        nativeVirtualKeyCode: def.nativeVirtualKeyCode
      };
      if (def.code) base.code = def.code;

      await send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
      if (def.text !== undefined) {
        await send('Input.dispatchKeyEvent', {
          ...base,
          type: 'char',
          text: def.text,
          unmodifiedText: def.text
        });
      }
      await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
      return { pressed: key };
    },
    { timeoutMs: 8000, targetIndex }
  );
}

/**
 * Selects an `<option>` inside a `<select>` element by value or visible label and dispatches input/change events.
 */
async function selectOption(debuggingPort, selector, { value, label, targetIndex = 0 } = {}) {
  if (!selector || typeof selector !== 'string') {
    throw new Error('Missing CSS selector for selectOption');
  }
  if (value === undefined && label === undefined) {
    throw new Error('Must provide either value or label for selectOption');
  }

  const safeSel = JSON.stringify(selector);
  const safeVal = value !== undefined ? JSON.stringify(String(value)) : 'undefined';
  const safeLabel = label !== undefined ? JSON.stringify(String(label)) : 'undefined';

  const expr = `(() => {
    const el = document.querySelector(${safeSel});
    if (!el) return { ok: false, error: 'Element not found for selector: ' + ${safeSel} };
    if (el.tagName !== 'SELECT') return { ok: false, error: 'Element is not a <select>: ' + el.tagName.toLowerCase() };
    const options = Array.from(el.options || []);
    const targetVal = ${safeVal};
    const targetLabel = ${safeLabel};
    let match = null;
    if (targetVal !== undefined) {
      match = options.find((o) => o.value === targetVal);
    }
    if (!match && targetLabel !== undefined) {
      const normLabel = targetLabel.trim();
      match = options.find((o) => (o.text || '').trim() === normLabel || (o.label || '').trim() === normLabel);
    }
    if (!match) {
      return { ok: false, error: 'No matching option found in <select> for selector: ' + ${safeSel} };
    }
    el.scrollIntoView({ behavior: 'instant', block: 'center' });
    el.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, match.value);
    } else {
      el.value = match.value;
    }
    match.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      ok: true,
      value: match.value,
      label: (match.text || match.label || '').trim()
    };
  })()`;

  return withCdpPage(
    debuggingPort,
    async (send) => {
      const result = await evalInSession(send, expr);
      if (!result || !result.ok) {
        throw new Error(result?.error || `selectOption failed for selector: ${selector}`);
      }
      return result;
    },
    { timeoutMs: 10000, targetIndex }
  );
}

/**
 * Retrieves browser cookies via CDP `Network.getCookies`.
 */
async function getCookies(debuggingPort, { urls, targetIndex = 0 } = {}) {
  const cleanUrls = Array.isArray(urls)
    ? urls.map((u) => String(u || '').trim()).filter(Boolean)
    : [];

  return withCdpPage(
    debuggingPort,
    async (send) => {
      await send('Network.enable');
      const params = cleanUrls.length > 0 ? { urls: cleanUrls } : {};
      const res = await send('Network.getCookies', params);
      const cookies = Array.isArray(res.cookies) ? res.cookies : [];
      return {
        count: cookies.length,
        cookies
      };
    },
    { timeoutMs: 10000, targetIndex }
  );
}

const VALID_SAME_SITE = new Set(['Strict', 'Lax', 'None']);

/**
 * Sets cookies into the running browser via CDP `Network.setCookies` (max 200).
 */
async function setCookies(debuggingPort, cookies, { targetIndex = 0 } = {}) {
  if (!Array.isArray(cookies)) {
    throw new Error('cookies must be an array');
  }
  if (cookies.length === 0) {
    throw new Error('cookies array must not be empty');
  }
  if (cookies.length > 200) {
    throw new Error(`Maximum 200 cookies allowed per call, received ${cookies.length}`);
  }

  const sanitized = cookies.map((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`Cookie at index ${idx} must be an object`);
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      throw new Error(`Cookie at index ${idx} is missing a valid name`);
    }
    const entry = {
      name,
      value: raw.value !== undefined && raw.value !== null ? String(raw.value) : ''
    };
    if (raw.url !== undefined && raw.url !== null && String(raw.url).trim() !== '') {
      const trimmedUrl = String(raw.url).trim();
      let parsedUrl;
      try {
        parsedUrl = new URL(trimmedUrl);
      } catch {
        throw new Error(`Cookie at index ${idx} has invalid url: ${trimmedUrl}`);
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error(`Cookie at index ${idx} url must use http: or https: protocol: ${trimmedUrl}`);
      }
      entry.url = parsedUrl.href;
    }
    if (typeof raw.domain === 'string' && raw.domain.trim()) entry.domain = raw.domain.trim();
    if (!entry.url && !entry.domain) {
      throw new Error(`Cookie at index ${idx} must specify either url or domain`);
    }
    if (typeof raw.path === 'string' && raw.path.trim()) entry.path = raw.path.trim();
    if (typeof raw.secure === 'boolean') entry.secure = raw.secure;
    if (typeof raw.httpOnly === 'boolean') entry.httpOnly = raw.httpOnly;
    if (typeof raw.sameSite === 'string' && VALID_SAME_SITE.has(raw.sameSite)) {
      entry.sameSite = raw.sameSite;
    }
    if (
      raw.expires !== undefined &&
      raw.expires !== null &&
      raw.expires !== '' &&
      typeof raw.expires !== 'boolean' &&
      Number.isFinite(Number(raw.expires))
    ) {
      entry.expires = Number(raw.expires);
    }
    return entry;
  });

  return withCdpPage(
    debuggingPort,
    async (send) => {
      await send('Network.enable');
      await send('Network.setCookies', { cookies: sanitized });
      return { setCount: sanitized.length };
    },
    { timeoutMs: 10000, targetIndex }
  );
}

module.exports = {
  resolvePageTarget,
  listPages,
  withCdpPage,
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
};
