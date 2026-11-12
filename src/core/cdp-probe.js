/**
 * VNT-Browser Built-in Fingerprint Verification Probe (`src/core/cdp-probe.js`)
 * Uses Node.js built-in WebSocket client to connect to a running profile's CDP page target
 * and extract live hardware, WebGL, Canvas, Audio, ClientRects, Timezone, and Prototype integrity data.
 */

const { fetchCdpJson } = require('./browser-manager');

const PROBE_EXPRESSION = `(() => {
  const getCanvasHash = () => {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 60;
    const ctx = c.getContext('2d');
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f60';
    ctx.fillRect(10, 10, 100, 30);
    ctx.fillStyle = '#069';
    ctx.font = '15px Arial';
    ctx.fillText('VNT-Browser 151 C++ Spoof', 12, 28);
    const data = c.toDataURL();
    let h = 0;
    for (let i = 0; i < data.length; i++) {
      h = ((h << 5) - h) + data.charCodeAt(i);
      h |= 0;
    }
    return '0x' + (h >>> 0).toString(16).padStart(8, '0');
  };

  const getWebGL = () => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    if (!gl) return {};
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS)
    };
  };

  return {
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver,
    platform: navigator.platform,
    vendor: navigator.vendor,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    languages: navigator.languages,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: screen.width + 'x' + screen.height,
    canvasHash: getCanvasHash(),
    webgl: getWebGL(),
    antiTamper: {
      ownNavPropsCount: Object.getOwnPropertyNames(navigator).length,
      toDataURLToString: HTMLCanvasElement.prototype.toDataURL.toString(),
      getParameterToString: WebGLRenderingContext.prototype.getParameter.toString()
    }
  };
})()`;

/**
 * Evaluates the live fingerprint probe inside a running profile's active page via CDP.
 *
 * @param {number} debuggingPort
 * @param {number} [timeoutMs=6000]
 * @returns {Promise<Object>}
 */
async function probeRunningProfile(debuggingPort, timeoutMs = 6000) {
  const targets = await fetchCdpJson(debuggingPort, '/json', 2000);
  const pageTarget = Array.isArray(targets) ? targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : null;
  if (!pageTarget) {
    throw new Error(`No inspectable page target found on CDP port ${debuggingPort}`);
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    let navTimer = null;
    let settled = false;

    const cleanupAndReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (navTimer) clearTimeout(navTimer);
      try { ws.close(); } catch {}
      reject(err);
    };

    const timer = setTimeout(() => {
      cleanupAndReject(new Error('CDP WebSocket probe timed out'));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      // Navigate to a secure origin (http://localhost) if currently on about:blank
      // so [SecureContext] APIs like navigator.deviceMemory and navigator.userAgentData are exposed.
      if (!pageTarget.url || pageTarget.url === 'about:blank') {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Page.navigate',
          params: { url: `http://localhost:${debuggingPort}/json/version` }
        }));
      } else {
        ws.send(JSON.stringify({
          id: 2,
          method: 'Runtime.evaluate',
          params: {
            expression: PROBE_EXPRESSION,
            returnByValue: true,
            awaitPromise: true
          }
        }));
      }
    });

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.id === 1) {
          navTimer = setTimeout(() => {
            try {
              if (ws.readyState === 1 /* OPEN */) {
                ws.send(JSON.stringify({
                  id: 2,
                  method: 'Runtime.evaluate',
                  params: {
                    expression: PROBE_EXPRESSION,
                    returnByValue: true,
                    awaitPromise: true
                  }
                }));
              } else {
                cleanupAndReject(new Error('CDP WebSocket closed before evaluation'));
              }
            } catch (err) {
              cleanupAndReject(err);
            }
          }, 150);
        } else if (msg.id === 2) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (navTimer) clearTimeout(navTimer);
          try { ws.close(); } catch {}
          if (msg.result && msg.result.result && msg.result.result.value) {
            resolve(msg.result.result.value);
          } else {
            reject(new Error('Unexpected CDP Runtime.evaluate response: ' + JSON.stringify(msg)));
          }
        }
      } catch (err) {
        cleanupAndReject(err);
      }
    });

    ws.addEventListener('close', () => {
      cleanupAndReject(new Error('CDP WebSocket closed before probe could finish'));
    });

    ws.addEventListener('error', (err) => {
      cleanupAndReject(new Error(`CDP WebSocket error: ${err.message || 'connection failed'}`));
    });
  });
}

module.exports = {
  probeRunningProfile,
  PROBE_EXPRESSION
};
