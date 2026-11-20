// noqa: debug-artifact-file
/**
 * VTN Anti-Browser App Release Cloud Upload Tool (`scripts/upload-app.js`)
 * Uploads compiled `dist/VTN-Anti-Browser.exe` and `system/app_latest.json`
 * (with SHA-256 integrity hash) to Cloudflare R2 for 1-Click Auto-Update.
 *
 * Usage:
 *   npm run cloud:upload-app
 *   node scripts/upload-app.js --notes "Release notes here"
 */

const path = require('node:path');
const fs = require('node:fs');
const { CloudSync } = require('../src/core/cloud-sync');
const { APP_VERSION } = require('../src/core/version');
const {
  APP_MANIFEST_KEY,
  APP_BINARY_KEY,
  publishRelease
} = require('../src/core/app-updater');

function parseCliArgs(argv) {
  const args = { notes: '', version: APP_VERSION, exePath: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--notes' && argv[i + 1] !== undefined) {
      args.notes = argv[++i];
    } else if (token.startsWith('--notes=')) {
      args.notes = token.slice('--notes='.length);
    } else if (token === '--version' && argv[i + 1] !== undefined) {
      args.version = argv[++i];
    } else if (token.startsWith('--version=')) {
      args.version = token.slice('--version='.length);
    } else if (token === '--exe' && argv[i + 1] !== undefined) {
      args.exePath = argv[++i];
    } else if (token.startsWith('--exe=')) {
      args.exePath = token.slice('--exe='.length);
    }
  }
  return args;
}

async function main() {
  console.log('============================================================');
  console.log('  VTN Anti-Browser — R2 1-Click Updater Release Publisher');
  console.log('============================================================\n');

  const cli = parseCliArgs(process.argv.slice(2));
  const cloudSync = new CloudSync();

  if (!cloudSync.isEnabled()) {
    console.error('❌ Lỗi: Cloudflare R2 chưa được kích hoạt hoặc chưa cấu hình.');
    console.error('   Vui lòng cấu hình Cloudflare R2 trong Settings trước khi đẩy bản phát hành.\n');
    process.exit(1);
  }

  const exePath = cli.exePath
    ? path.resolve(cli.exePath)
    : path.resolve(__dirname, '..', 'dist', 'VTN-Anti-Browser.exe');

  if (!fs.existsSync(exePath)) {
    console.error(`❌ Lỗi: Không tìm thấy file thực thi tại: ${exePath}`);
    console.error('   Hãy chạy "npm run build:exe" trước khi đẩy lên R2.\n');
    process.exit(1);
  }

  console.log(`📦 File nguồn:   ${exePath}`);
  console.log(`🏷️  Phiên bản:    v${cli.version}`);
  console.log(`☁️  Bucket R2:    ${cloudSync.r2Client.bucket}`);
  console.log(`🎯 Binary Key:   ${APP_BINARY_KEY}`);
  console.log(`📄 Manifest Key: ${APP_MANIFEST_KEY}`);
  if (cli.notes) {
    console.log(`📝 Ghi chú:      ${cli.notes}`);
  }
  console.log('\n⏳ Đang tính SHA-256 và tải bản phát hành lên Cloudflare R2...');

  const startTime = Date.now();
  try {
    const { manifest } = await publishRelease(cloudSync, {
      exePath,
      version: cli.version,
      notes: cli.notes
    });
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const mb = (manifest.sizeBytes / (1024 * 1024)).toFixed(2);

    console.log('\n✅ [THÀNH CÔNG] Đã phát hành bản cập nhật lên Cloudflare R2!');
    console.log(`   • Phiên bản:  v${manifest.version}`);
    console.log(`   • Dung lượng: ${mb} MB (${manifest.sizeBytes} bytes)`);
    console.log(`   • SHA-256:    ${manifest.sha256}`);
    console.log(`   • Thời gian:  ${duration}s`);
    console.log('\n🎉 Các máy khác có thể bấm "Tải & Cập nhật 1-Click" trong giao diện VTN Anti-Browser.');
  } catch (err) {
    console.error('\n❌ Phát hành thất bại:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, parseCliArgs };
