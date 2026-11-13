/**
 * Test Facebook Cookie Login & AI Interaction (Mode 2: React + Comment)
 * Usage: node tests/test_fb_login.js
 */

const fs = require('fs');
const path = require('path');
const { FacebookRunner } = require('../automation/scenarios/facebook_runner');

async function main() {
  const accountsPath = path.resolve(__dirname, '..', 'automation', 'config', 'accounts_facebook.json');
  const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));

  if (!accounts || accounts.length === 0) {
    process.stderr.write('Không tìm thấy tài khoản nào trong config!\n');
    process.exit(1);
  }

  const account = accounts[0];
  process.stdout.write(`Bắt đầu chạy thử nghiệm nạp cookie cho UID: ${account.uid}\n`);

  const runner = new FacebookRunner(account);
  try {
    const result = await runner.runSession({ headless: false, allowComment: true });
    process.stdout.write(`Kết quả phiên chạy: ${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Lỗi phiên chạy: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
