/**
 * Test Real AI Interaction on Facebook Feed
 * Finds a post via its Like button, scrolls into view,
 * analyzes content with AI, clicks Like and types a comment.
 */

const fs = require('fs');
const path = require('path');
const { VtnBridge } = require('../automation/core/vtn_bridge');
const { Humanizer } = require('../automation/core/humanizer');
const { GeminiAdapter } = require('../automation/ai/gemini');
const { FbDomInteractor } = require('../automation/core/fb_dom_interactor');

async function main() {
  const accountsPath = path.resolve(__dirname, '..', 'automation', 'config', 'accounts_facebook.json');
  const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  const account = accounts[0];

  const bridge = new VtnBridge();
  const gemini = new GeminiAdapter();

  process.stdout.write('[Real-Test] Khoi dong Profile: ' + account.profileId + ' qua VTN Core...\n');
  const launch = await bridge.openProfile(account.profileId, { headless: false, startUrl: 'about:blank' });
  const wsUrl = launch.pageWsEndpoint || launch.browserWsEndpoint;
  process.stdout.write('[Real-Test] Profile da mo tren CDP: ' + launch.debuggingPort + '\n');

  // 1. Nap 9 cookies
  process.stdout.write('[Real-Test] Nap 9 cookies vao session...\n');
  await bridge.injectCookies(wsUrl, account.cookies);

  // 2. Dieu huong toi Facebook
  process.stdout.write('[Real-Test] Dieu huong toi https://www.facebook.com...\n');
  await bridge.executeCdpCommands(wsUrl, [{ method: 'Page.navigate', params: { url: 'https://www.facebook.com' } }]);
  await Humanizer.sleep(8000);

  // Lay WebSocket trang hien tai
  const activeWs = (await bridge.getActivePageWs(launch.debuggingPort)) || wsUrl;

  // 3. Cuon nhe 1 nhip xuong feed
  process.stdout.write('[Real-Test] Cuon trang 400px de kich hoat feed...\n');
  await bridge.executeCdpCommands(activeWs, [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 500, y: 500, deltaX: 0, deltaY: 400 } }
  ]);
  await Humanizer.sleep(3000);

  // 4. Dinh vi bai viet bang nut Thich truc tiep
  process.stdout.write('[Real-Test] Tim bai viet bang nut Thich truc tiep...\n');
  const findPostExpr = `(() => {
    const likeBtns = Array.from(document.querySelectorAll('div[aria-label="Thích"], div[aria-label="Like"], div[role="button"][aria-label*="Thích"]'));
    for (const lb of likeBtns) {
      // Find post container
      const postContainer = lb.closest('[role="article"]') || lb.closest('div[data-virtualized="false"]') || lb.parentElement.parentElement.parentElement;
      const text = postContainer ? postContainer.innerText.slice(0, 300).replace(/\\n/g, ' ') : '';
      
      // Sibling toolbar containing comment button
      const row = lb.closest('[role="toolbar"]') || lb.parentElement.parentElement;
      const commentBtn = row ? row.querySelector('[aria-label*="bình luận"], [aria-label*="Bình luận"], [role="button"][aria-label*="bình luận"], [role="button"][aria-label*="Bình luận"]') : null;

      lb.scrollIntoView({ behavior: 'instant', block: 'center' });
      const lRect = lb.getBoundingClientRect();
      const cRect = commentBtn ? commentBtn.getBoundingClientRect() : null;

      if (lRect.width > 0 && lRect.height > 0) {
        return {
          found: true,
          textSnippet: text || 'Bài viết bảng tin',
          likeCoords: { x: Math.round(lRect.left + lRect.width / 2), y: Math.round(lRect.top + lRect.height / 2) },
          commentCoords: cRect && cRect.width > 0 ? { x: Math.round(cRect.left + cRect.width / 2), y: Math.round(cRect.top + cRect.height / 2) } : null
        };
      }
    }
    return { found: false, countLikeBtns: likeBtns.length };
  })()`;

  const postRes = await bridge.executeCdpCommands(activeWs, [
    { method: 'Runtime.evaluate', params: { expression: findPostExpr, returnByValue: true, awaitPromise: true } }
  ]);
  const postInfo = postRes[0]?.result?.result?.value;
  process.stdout.write('[Real-Test] Ket qua tim bai: ' + JSON.stringify(postInfo) + '\n');

  if (!postInfo || !postInfo.found) {
    process.stderr.write('[Real-Test] Khong tim thay bai viet phu hop de tuong tac.\n');
    process.exit(1);
  }

  // 5. AI phan tich noi dung
  process.stdout.write('[Real-Test] Gui trich doan bai viet sang Gemini phan tich...\n');
  const aiDecision = await gemini.analyzePost(postInfo.textSnippet, 'VN');
  process.stdout.write('[Real-Test] AI Decision: [Action: ' + aiDecision.reaction + '] - Reason: ' + aiDecision.reason + '\n');
  process.stdout.write('[Real-Test] AI Comment sinh ra: "' + aiDecision.comment + '"\n');

  // 6. Click Thich
  let liked = false;
  if (postInfo.likeCoords && postInfo.likeCoords.x > 0) {
    process.stdout.write('[Real-Test] Click nut Thich tai toa do: ' + JSON.stringify(postInfo.likeCoords) + '...\n');
    await FbDomInteractor.clickCoordinates(bridge, activeWs, postInfo.likeCoords);
    liked = true;
    await Humanizer.sleep(2000);
  }

  // 7. Click o Binh luan va go noi dung
  let commented = false;
  if (postInfo.commentCoords && postInfo.commentCoords.x > 0 && aiDecision.comment) {
    process.stdout.write('[Real-Test] Click vao o Binh luan tai toa do: ' + JSON.stringify(postInfo.commentCoords) + '...\n');
    await FbDomInteractor.clickCoordinates(bridge, activeWs, postInfo.commentCoords);
    await Humanizer.sleep(1500);

    process.stdout.write('[Real-Test] Go noi dung binh luan qua ban phim Humanizer...\n');
    await FbDomInteractor.typeHumanText(bridge, activeWs, aiDecision.comment);
    commented = true;
    await Humanizer.sleep(3000);
  }

  process.stdout.write('\n=== KET QUA THUC NGHIEM CUOI CUNG ===\n');
  process.stdout.write(JSON.stringify({
    success: true,
    snippet: postInfo.textSnippet,
    aiDecision,
    liked,
    commented
  }, null, 2) + '\n');

  process.exit(0);
}

main().catch(err => {
  process.stderr.write('[FATAL] Lỗi: ' + err.stack + '\n');
  process.exit(1);
});
