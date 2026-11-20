/**
 * Humanizer Controller
 * Simulates physical mouse movements using Bézier curves and typing jitters.
 */

class Humanizer {
  static sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  static randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  static async naturalType(page, selector, text) {
    for (const char of text) {
      await page.type(selector, char, { delay: this.randomBetween(60, 160) });
    }
  }

  static async randomScroll(page) {
    const scrollDistance = this.randomBetween(250, 600);
    await page.mouse.wheel(0, scrollDistance);
    await this.sleep(this.randomBetween(2000, 5000));
  }
}

module.exports = { Humanizer };
