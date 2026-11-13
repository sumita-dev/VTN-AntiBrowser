/**
 * Facebook DOM Interactor & Action Dispatcher
 * Evaluates posts and sends realistic human clicks/typing via CDP Input domain.
 */

const { Humanizer } = require('./humanizer');

const EXTRACT_STANDARD_POST_EXPRESSION = `(() => {
  const articles = Array.from(document.querySelectorAll('div[role="feed"] > div, div[role="article"]'));
  for (const art of articles) {
    // Avoid non-post elements (stories, reels, ads, banners)
    const text = art.innerText ? art.innerText.trim() : '';
    if (text.length < 30 || text.includes('Tạo tin') || text.includes('Reels và video ngắn')) {
      continue;
    }

    // Find Like button
    const likeBtn = art.querySelector('[aria-label="Thích"], [aria-label="Like"], [role="button"][aria-label*="Thích"], [role="button"][aria-label*="Like"]');
    // Find Comment button
    const commentBtn = art.querySelector('[aria-label*="bình luận"], [aria-label*="Bình luận"], [role="button"][aria-label*="bình luận"], [role="button"][aria-label*="Bình luận"]');

    if (likeBtn && commentBtn) {
      // Scroll article into central view
      art.scrollIntoView({ behavior: 'instant', block: 'center' });
      const lRect = likeBtn.getBoundingClientRect();
      const cRect = commentBtn.getBoundingClientRect();

      if (lRect.width > 0 && lRect.height > 0 && cRect.width > 0 && cRect.height > 0) {
        return {
          found: true,
          snippet: text.slice(0, 300).replace(/\n/g, ' '),
          likeCoords: { x: Math.round(lRect.left + lRect.width / 2), y: Math.round(lRect.top + lRect.height / 2) },
          commentCoords: { x: Math.round(cRect.left + cRect.width / 2), y: Math.round(cRect.top + cRect.height / 2) }
        };
      }
    }
  }
  return { found: false };
})()`;

class FbDomInteractor {
  static async findStandardPost(vtnBridge, wsUrl) {
    const res = await vtnBridge.executeCdpCommands(wsUrl, [
      {
        method: 'Runtime.evaluate',
        params: {
          expression: EXTRACT_STANDARD_POST_EXPRESSION,
          returnByValue: true,
          awaitPromise: true
        }
      }
    ]);
    return res[0]?.result?.result?.value || { found: false };
  }

  static async clickCoordinates(vtnBridge, wsUrl, coords) {
    if (!coords || !coords.x || !coords.y) return false;
    const { x, y } = coords;
    await vtnBridge.executeCdpCommands(wsUrl, [
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x, y } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } }
    ]);
    return true;
  }

  static async typeHumanText(vtnBridge, wsUrl, text) {
    for (const char of text) {
      await vtnBridge.executeCdpCommands(wsUrl, [
        { method: 'Input.insertText', params: { text: char } }
      ]);
      await Humanizer.sleep(Humanizer.randomBetween(50, 130));
    }
    // Press Enter to submit comment
    await Humanizer.sleep(Humanizer.randomBetween(400, 800));
    await vtnBridge.executeCdpCommands(wsUrl, [
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 } }
    ]);
  }
}

module.exports = { FbDomInteractor };
