/**
 * Facebook AI Automation Runner
 * Handles cookie injection, session validation, group browsing,
 * and AI-driven reaction/comment interaction via Gemini 2.5 Flash.
 */

const fs = require('fs');
const path = require('path');
const { VtnBridge } = require('../core/vtn_bridge');
const { Humanizer } = require('../core/humanizer');
const { GeminiAdapter } = require('../ai/gemini');
const { FbDomInteractor } = require('../core/fb_dom_interactor');

const AI_CONFIG_PATH = path.resolve(__dirname, '..', '..', 'data', 'ai_config.json');

class FacebookRunner {
  constructor(accountConfig, logger = null) {
    this.account = accountConfig;
    this.bridge = new VtnBridge();
    this.gemini = new GeminiAdapter();
    this.logger = logger || ((msg) => process.stdout.write(msg + '\n'));
  }

  _loadAiConfig() {
    try {
      if (fs.existsSync(AI_CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf8'));
      }
    } catch {}
    return {};
  }

  async runSession(options = {}) {
    this.logger('[FB-Runner] Khoi dong phien Facebook cho UID: ' + this.account.uid);
    this.logger('[FB-Runner] Profile gan kem: ' + this.account.profileId);

    // 1. Mo Profile qua VTN-Browser Core
    const launchInfo = await this.bridge.openProfile(this.account.profileId, {
      headless: Boolean(options.headless),
      startUrl: 'about:blank'
    });

    this.logger('[FB-Runner] Profile da mo thanh cong tren cong CDP: ' + launchInfo.debuggingPort);
    const wsUrl = launchInfo.pageWsEndpoint || launchInfo.browserWsEndpoint;

    // 2. Nap Cookies qua CDP
    if (this.account.cookies && this.account.cookies.length > 0) {
      this.logger('[FB-Runner] Dang nap ' + this.account.cookies.length + ' cookies vao session...');
      await this.bridge.injectCookies(wsUrl, this.account.cookies);
      this.logger('[FB-Runner] Nap cookies thanh cong qua CDP.');
    }

    // 3. Dieu huong toi Facebook trang chu de xac thuc session
    this.logger('[FB-Runner] Dang dieu huong toi https://www.facebook.com...');
    await this.bridge.executeCdpCommands(wsUrl, [
      { method: 'Page.navigate', params: { url: 'https://www.facebook.com' } }
    ]);
    await Humanizer.sleep(4000);

    const aiConfig = this._loadAiConfig();

    // 4. Lan luot tuong tac voi cac nhom muc tieu
    const targetGroups = (this.account.targetGroups && this.account.targetGroups.length > 0)
      ? this.account.targetGroups
      : (Array.isArray(aiConfig.targetGroups) ? aiConfig.targetGroups : []);
    const interactionSummary = [];

    for (let i = 0; i < targetGroups.length; i++) {
      const groupUrl = targetGroups[i];
      this.logger('[FB-Runner] (' + (i + 1) + '/' + targetGroups.length + ') Dang truy cap nhom: ' + groupUrl);
      await this.bridge.executeCdpCommands(wsUrl, [
        { method: 'Page.navigate', params: { url: groupUrl } }
      ]);
      await Humanizer.sleep(6000);

      // Cuon nhe mo phong luot doc
      await this.bridge.executeCdpCommands(wsUrl, [
        { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 400, y: 400, deltaX: 0, deltaY: 350 } }
      ]);
      await Humanizer.sleep(3000);

      // Boc tach bai viet
      this.logger('[FB-Runner] Dang trich xuat noi dung bai viet tu DOM...');
      const targetPost = await FbDomInteractor.findStandardPost(this.bridge, wsUrl);

      if (targetPost && targetPost.found) {
        const snippet = (targetPost.snippet || '').slice(0, 100).replace(/\n/g, ' ');
        this.logger('[FB-Runner] Bai viet muc tieu: "' + snippet + '..."');

        // AI phan tich cam xuc va sinh noi dung
        this.logger('[FB-Runner] Dang gui bai viet sang Gemini AI de phan tich...');
        const aiDecision = await this.gemini.analyzePost(
          targetPost.snippet || '',
          this.account.region || aiConfig.locale || 'VN',
          aiConfig.persona || ''
        );
        this.logger('[FB-Runner] Ket qua AI: [Action: ' + aiDecision.reaction + '] - Ly do: ' + aiDecision.reason);

        let reacted = false;
        let commented = false;

        // Tha Like neu AI khuyen nghi va cau hinh cho phep
        const allowLike = aiConfig.autoLike !== false;
        if (allowLike && aiDecision.shouldInteract && targetPost.likeCoords) {
          this.logger('[FB-Runner] Dang di chuot va tha cam xuc ' + aiDecision.reaction + '...');
          await FbDomInteractor.clickCoordinates(this.bridge, wsUrl, targetPost.likeCoords);
          reacted = true;
          await Humanizer.sleep(2000);
        }

        // Binh luan neu co noi dung va cho phep
        const allowComment = (options.allowComment !== false) && (aiConfig.autoComment !== false);
        if (allowComment && aiDecision.comment && targetPost.commentCoords) {
          this.logger('[FB-Runner] Dang viet binh luan: "' + aiDecision.comment + '"');
          await FbDomInteractor.clickCoordinates(this.bridge, wsUrl, targetPost.commentCoords);
          await Humanizer.sleep(1500);
          await FbDomInteractor.typeHumanText(this.bridge, wsUrl, aiDecision.comment);
          commented = true;
        }

        interactionSummary.push({
          groupUrl,
          snippet,
          aiDecision,
          reacted,
          commented
        });
      }
    }

    this.logger('[FB-Runner] Hoan tat chuoi tuong tac nhom bang AI.');

    return {
      ok: true,
      profileId: this.account.profileId,
      uid: this.account.uid,
      debuggingPort: launchInfo.debuggingPort,
      interactions: interactionSummary
    };
  }
}

module.exports = { FacebookRunner };
