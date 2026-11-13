/**
 * Test Both Automation Options with Empirical Evidence
 * Option 1: Auto-Click "Tham gia nhóm" on target group
 * Option 2: AI Read post, React, and Type comment on Public Fanpage
 */

const fs = require('fs');
const path = require('path');
const { VtnBridge } = require('../automation/core/vtn_bridge');
const { Humanizer } = require('../automation/core/humanizer');
const { GeminiAdapter } = require('../automation/ai/gemini');
const { FbDomInteractor } = require('../automation/core/fb_dom_interactor');

async function run() {
  const accountsPath = path.resolve(__dirname, '..', 'automation', 'config', 'accounts_facebook.json');
  const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  const account = accounts[0];

  const bridge = new VtnBridge();
  const gemini = new GeminiAdapter();

  process.stdout.write('[Test] Khoi dong Profile: ' + account.profileId + ' qua VTN Core...\n');
  const launch = await bridge.openProfile(account.profileId, { headless: false, startUrl: 'about:blank' });
  const wsUrl = launch.pageWsEndpoint || launch.browserWsEndpoint;
  process.stdout.write('[Test] Profile da mo tren CDP: ' + launch.debuggingPort + '\n');

  // Nap cookies
  process.stdout.write('[Test] Nap cookies cho UID: ' + account.uid + '...\n');
  await bridge.injectCookies(wsUrl, account.cookies);

  // ==========================================
  // PHUONG AN 1: AUTO CLICK "THAM GIA NHOM"
  // ==========================================
  process.stdout.write('\n=== [PHUONG AN 1]: THU NGHIEM BAM THAM GIA NHOM ===\n');
  const groupUrl = 'https://www.facebook.com/groups/1569314343856132/'; // Build in Public VN
  process.stdout.write('[PA1] Dieu huong toi nhom: ' + groupUrl + '\n');
  await bridge.executeCdpCommands(wsUrl, [{ method: 'Page.navigate', params: { url: groupUrl } }]);
  await Humanizer.sleep(8000);

  // Tim nut Tham gia nhom va toa do
  const findJoinExpr = `(() => {
    const buttons = Array.from(document.querySelectorAll('[role="button"], div[aria-label]'));
    const joinBtn = buttons.find(b => {
      const text = (b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '');
      return text.includes('Tham gia nhóm') || text.includes('Tham gia');
    });
    if (!joinBtn) return { found: false };
    const rect = joinBtn.getBoundingClientRect();
    return {
      found: true,
      text: joinBtn.innerText || joinBtn.getAttribute('aria-label'),
      coords: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    };
  })()`;

  const joinRes = await bridge.executeCdpCommands(wsUrl, [
    { method: 'Runtime.evaluate', params: { expression: findJoinExpr, returnByValue: true, awaitPromise: true } }
  ]);
  const joinData = joinRes[0]?.result?.result?.value;
  process.stdout.write('[PA1] Ket qua tim nut: ' + JSON.stringify(joinData) + '\n');

  let pa1Result = { success: false, detail: 'Khong tim thay nut' };
  if (joinData && joinData.found && joinData.coords.x > 0 && joinData.coords.y > 0) {
    process.stdout.write('[PA1] Di chuot va click vao nut Tham gia tai: ' + JSON.stringify(joinData.coords) + '...\n');
    await FbDomInteractor.clickCoordinates(bridge, wsUrl, joinData.coords);
    await Humanizer.sleep(5000);

    // Kiem tra trang thai sau khi click
    const afterClickExpr = `(() => {
      const buttons = Array.from(document.querySelectorAll('[role="button"], div[aria-label]'));
      const text = buttons.map(b => (b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).join(' | ');
      const hasPending = text.includes('Đã hủy yêu cầu') || text.includes('Đã yêu cầu') || text.includes('Đã tham gia');
      const dialog = document.querySelector('[role="dialog"]');
      return {
        hasPending,
        hasQuestionsDialog: Boolean(dialog),
        dialogText: dialog ? dialog.innerText.slice(0, 200) : null
      };
    })()`;
    const checkRes = await bridge.executeCdpCommands(wsUrl, [
      { method: 'Runtime.evaluate', params: { expression: afterClickExpr, returnByValue: true, awaitPromise: true } }
    ]);
    pa1Result = { success: true, detail: checkRes[0]?.result?.result?.value };
    process.stdout.write('[PA1] Trang thai sau click: ' + JSON.stringify(pa1Result.detail) + '\n');
  }

  // ==========================================
  // PHUONG AN 2: TUONG TAC FANPAGE CONG KHAI
  // ==========================================
  process.stdout.write('\n=== [PHUONG AN 2]: THU NGHIEM FANPAGE CONG KHAI ===\n');
  const pageUrl = 'https://www.facebook.com/vietnamnet.vn';
  process.stdout.write('[PA2] Dieu huong toi Fanpage: ' + pageUrl + '\n');
  await bridge.executeCdpCommands(wsUrl, [{ method: 'Page.navigate', params: { url: pageUrl } }]);
  await Humanizer.sleep(8000);

  // Cuon nhe xuong bai viet dau tien
  await bridge.executeCdpCommands(wsUrl, [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: 450 } }
  ]);
  await Humanizer.sleep(3000);

  // Trich xuat bai viet va nut tuong tac tren Fanpage
  const extractPagePostExpr = `(() => {
    const articles = document.querySelectorAll('div[role="feed"] > div, div[role="article"]');
    for (const art of articles) {
      const text = art.innerText ? art.innerText.trim() : '';
      if (text.length > 30) {
        const likeBtn = art.querySelector('[aria-label="Thích"], [aria-label="Like"], [role="button"][aria-label*="Thích"]');
        const commentBtn = art.querySelector('[aria-label*="bình luận"], [aria-label*="Bình luận"], [role="button"][aria-label*="bình luận"]');
        let likeCoords = null;
        let commentCoords = null;
        if (likeBtn) {
          const r = likeBtn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) likeCoords = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        if (commentBtn) {
          const r = commentBtn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) commentCoords = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
        return {
          found: true,
          snippet: text.slice(0, 150).replace(/\\n/g, ' '),
          likeCoords,
          commentCoords
        };
      }
    }
    return { found: false };
  })()`;

  const pagePostRes = await bridge.executeCdpCommands(wsUrl, [
    { method: 'Runtime.evaluate', params: { expression: extractPagePostExpr, returnByValue: true, awaitPromise: true } }
  ]);
  const postData = pagePostRes[0]?.result?.result?.value;
  process.stdout.write('[PA2] Ket qua tim bai viet tren Page: ' + JSON.stringify(postData) + '\n');

  let pa2Result = { success: false, postData, aiDecision: null, reacted: false, commented: false };

  if (postData && postData.found) {
    // Goi AI phan tich noi dung
    const aiDecision = await gemini.analyzePost(postData.snippet, 'VN');
    pa2Result.aiDecision = aiDecision;
    process.stdout.write('[PA2] AI Decision: [Action: ' + aiDecision.reaction + '] - Comment: "' + aiDecision.comment + '"\n');

    // Thuc hien click Like
    if (postData.likeCoords && postData.likeCoords.x > 0) {
      process.stdout.write('[PA2] Di chuot click Thich tai: ' + JSON.stringify(postData.likeCoords) + '...\n');
      await FbDomInteractor.clickCoordinates(bridge, wsUrl, postData.likeCoords);
      pa2Result.reacted = true;
      await Humanizer.sleep(2000);
    }

    // Thuc hien click Comment va nhap noi dung
    if (postData.commentCoords && postData.commentCoords.x > 0 && aiDecision.comment) {
      process.stdout.write('[PA2] Di chuot click o Binh luan tai: ' + JSON.stringify(postData.commentCoords) + '...\n');
      await FbDomInteractor.clickCoordinates(bridge, wsUrl, postData.commentCoords);
      await Humanizer.sleep(1500);

      process.stdout.write('[PA2] Go noi dung binh luan qua ban phim Humanizer...\n');
      await FbDomInteractor.typeHumanText(bridge, wsUrl, aiDecision.comment);
      pa2Result.commented = true;
    }
    pa2Result.success = true;
  }

  process.stdout.write('\n=== TONG HOP BANG CHUNG THUC NGHIEM ===\n');
  process.stdout.write(JSON.stringify({ pa1Result, pa2Result }, null, 2) + '\n');
  process.exit(0);
}

run().catch(err => {
  process.stderr.write('[FATAL] Lỗi chạy thử nghiệm: ' + err.stack + '\n');
  process.exit(1);
});
