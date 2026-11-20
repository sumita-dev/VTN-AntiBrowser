/**
 * VTN Anti-Browser R2 1-Click Auto-Updater (`src/core/app-updater.js`)
 * Zero-dependency self-updater using Cloudflare R2 / S3-compatible storage,
 * streaming SHA-256 integrity verification, atomic backup (.old.exe), and safe
 * detached Windows batch swap for Node SEA executables.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { IS_SEA, APP_ROOT } = require('./paths');
const { APP_VERSION, compareSemver } = require('./version');

const APP_MANIFEST_KEY = 'system/app_latest.json';
const APP_BINARY_KEY = 'system/VTN-Anti-Browser.exe';

/**
 * Computes lowercase hex SHA-256 digest of a file using streaming I/O.
 *
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Resolves default target executable path for SEA vs Development mode.
 *
 * @returns {string}
 */
function getDefaultExePath() {
  return IS_SEA
    ? process.execPath
    : path.join(APP_ROOT, 'dist', 'VTN-Anti-Browser.exe');
}

/**
 * Computes sibling staging (.new.exe) and backup (.old.exe) paths for a target exe.
 *
 * @param {string} [targetExePath]
 * @returns {{ targetPath: string, newPath: string, oldPath: string }}
 */
function getSiblingExePaths(targetExePath) {
  const targetPath = path.resolve(targetExePath || getDefaultExePath());
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const stem = base.toLowerCase().endsWith('.exe') ? base.slice(0, -4) : base;
  return {
    targetPath,
    newPath: path.join(dir, `${stem}.new.exe`),
    oldPath: path.join(dir, `${stem}.old.exe`)
  };
}

/**
 * Validates that a file path is safe to embed inside a quoted Windows batch command.
 *
 * @param {string} p
 */
function assertSafeBatchPath(p) {
  const str = String(p || '');
  if (!str || /[\0\r\n"&|<>^%!]/.test(str)) {
    throw new Error(`Đường dẫn không an toàn cho script cập nhật: ${str}`);
  }
}

/**
 * Writes and spawns a detached Windows batch helper to swap an active SEA exe
 * after the current process exits, relaunch it, and self-delete the batch file.
 *
 * @param {Object} opts
 * @param {string} opts.sourcePath
 * @param {string} opts.targetPath
 * @param {string|null} [opts.backupPath]
 */
function spawnWindowsSwapHelper({ sourcePath, targetPath, backupPath = null }) {
  assertSafeBatchPath(sourcePath);
  assertSafeBatchPath(targetPath);
  if (backupPath) {
    assertSafeBatchPath(backupPath);
  }

  const helperName = `vtn_updater_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.cmd`;
  let helperPath = path.join(os.tmpdir(), helperName);
  try {
    assertSafeBatchPath(helperPath);
  } catch {
    helperPath = path.join(path.dirname(targetPath), helperName);
    assertSafeBatchPath(helperPath);
  }

  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'ping -n 3 127.0.0.1 >nul',
    'set /a tries=0'
  ];

  if (backupPath) {
    lines.push('set moved_backup=0');
    lines.push(':retry_backup');
    lines.push(`if not exist "${targetPath}" goto do_swap`);
    lines.push(`move /y "${targetPath}" "${backupPath}" >nul 2>&1`);
    lines.push('if not errorlevel 1 (');
    lines.push('  set moved_backup=1');
    lines.push('  goto do_swap');
    lines.push(')');
    lines.push('set /a tries+=1');
    lines.push('if %tries% GEQ 15 goto finish');
    lines.push('ping -n 2 127.0.0.1 >nul');
    lines.push('goto retry_backup');
    lines.push(':do_swap');
    lines.push('set /a tries=0');
    lines.push(':retry_swap');
    lines.push(`move /y "${sourcePath}" "${targetPath}" >nul 2>&1`);
    lines.push('if not errorlevel 1 goto launch');
    lines.push('set /a tries+=1');
    lines.push('if %tries% GEQ 15 goto restore_backup');
    lines.push('ping -n 2 127.0.0.1 >nul');
    lines.push('goto retry_swap');
    lines.push(':restore_backup');
    lines.push('if "%moved_backup%"=="1" (');
    lines.push(`  if exist "${backupPath}" (`);
    lines.push(`    move /y "${backupPath}" "${targetPath}" >nul 2>&1`);
    lines.push('  )');
    lines.push(')');
  } else {
    lines.push(':retry_swap');
    lines.push(`move /y "${sourcePath}" "${targetPath}" >nul 2>&1`);
    lines.push('if not errorlevel 1 goto launch');
    lines.push('set /a tries+=1');
    lines.push('if %tries% GEQ 15 goto launch');
    lines.push('ping -n 2 127.0.0.1 >nul');
    lines.push('goto retry_swap');
  }

  lines.push(':launch');
  lines.push(`if exist "${targetPath}" (`);
  lines.push(`  start "" "${targetPath}"`);
  lines.push(')');
  lines.push(':finish');
  lines.push('del /f /q "%~f0" >nul 2>&1');

  fs.writeFileSync(helperPath, lines.join('\r\n') + '\r\n', 'utf8');

  const child = spawn('cmd.exe', ['/d', '/c', helperPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  return helperPath;
}

/**
 * Checks Cloudflare R2 for a newer application release.
 *
 * @param {Object} cloudSync
 * @param {Object} [options={}]
 * @param {string} [options.currentVersion=APP_VERSION]
 * @param {string} [options.targetExePath]
 */
async function checkForUpdate(cloudSync, { currentVersion = APP_VERSION, targetExePath } = {}) {
  const { oldPath } = getSiblingExePaths(targetExePath);
  const hasBackup = fs.existsSync(oldPath);

  if (!cloudSync || !cloudSync.isEnabled()) {
    return {
      ok: true,
      enabled: false,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      hasRelease: false,
      manifest: null,
      isSea: IS_SEA,
      hasBackup,
      reason: 'Cloudflare R2 chưa được cấu hình hoặc đang tắt.'
    };
  }

  const obj = await cloudSync.r2Client.getObject(APP_MANIFEST_KEY);
  if (!obj || !obj.body || obj.body.length === 0) {
    return {
      ok: true,
      enabled: true,
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      hasRelease: false,
      manifest: null,
      isSea: IS_SEA,
      hasBackup
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(obj.body.toString('utf8'));
  } catch (err) {
    throw new Error(`Manifest cập nhật trên R2 bị lỗi định dạng JSON: ${err.message}`);
  }

  const latestVersion = manifest && manifest.version ? String(manifest.version).trim() : null;
  const updateAvailable = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0);

  return {
    ok: true,
    enabled: true,
    currentVersion,
    latestVersion,
    updateAvailable,
    hasRelease: Boolean(latestVersion),
    manifest,
    isSea: IS_SEA,
    hasBackup
  };
}

/**
 * Uploads the compiled VTN-Anti-Browser.exe and its SHA-256 manifest to Cloudflare R2.
 *
 * @param {Object} cloudSync
 * @param {Object} [options={}]
 * @param {string} [options.exePath]
 * @param {string} [options.version=APP_VERSION]
 * @param {string} [options.notes='']
 */
async function publishRelease(cloudSync, { exePath, version = APP_VERSION, notes = '' } = {}) {
  if (!cloudSync || !cloudSync.isEnabled()) {
    throw new Error('Cloudflare R2 chưa được cấu hình hoặc đang tắt.');
  }

  const resolvedExe = path.resolve(exePath || getDefaultExePath());
  if (!fs.existsSync(resolvedExe) || !fs.statSync(resolvedExe).isFile()) {
    throw new Error(`Không tìm thấy file thực thi .exe tại: ${resolvedExe}. Hãy chạy "npm run build:exe" trước.`);
  }

  const stat = fs.statSync(resolvedExe);
  const sha256 = await computeFileSha256(resolvedExe);
  const buf = fs.readFileSync(resolvedExe);

  await cloudSync.r2Client.putObject(
    APP_BINARY_KEY,
    buf,
    'application/octet-stream'
  );

  const manifest = {
    version: String(version || APP_VERSION).trim(),
    buildDate: new Date().toISOString(),
    notes: String(notes || '').trim(),
    sizeBytes: stat.size,
    sha256,
    objectKey: APP_BINARY_KEY
  };

  await cloudSync.r2Client.putObject(
    APP_MANIFEST_KEY,
    JSON.stringify(manifest, null, 2),
    'application/json'
  );

  return {
    ok: true,
    manifest
  };
}

/**
 * Downloads the latest release from Cloudflare R2, verifies minimum size & exact SHA-256,
 * backs up the existing executable to .old.exe, and replaces or stages it for restart.
 *
 * @param {Object} cloudSync
 * @param {Object} [options={}]
 * @param {string} [options.targetExePath]
 * @param {number} [options.minBytes=1024]
 * @param {boolean} [options.autoRestartInSea=true]
 */
async function downloadAndStageUpdate(cloudSync, {
  targetExePath,
  minBytes = 1024,
  autoRestartInSea = true
} = {}) {
  if (!cloudSync || !cloudSync.isEnabled()) {
    throw new Error('Cloudflare R2 chưa được cấu hình hoặc đang tắt.');
  }

  const manifestObj = await cloudSync.r2Client.getObject(APP_MANIFEST_KEY);
  if (!manifestObj || !manifestObj.body || manifestObj.body.length === 0) {
    throw new Error('Chưa có bản phát hành (system/app_latest.json) nào trên Cloudflare R2.');
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestObj.body.toString('utf8'));
  } catch (err) {
    throw new Error(`Manifest trên R2 không hợp lệ: ${err.message}`);
  }

  const expectedSha = String(manifest.sha256 || '').trim().toLowerCase();
  const objectKey = String(manifest.objectKey || '').trim();
  if (!/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw new Error('Manifest trên R2 thiếu mã kiểm tra toàn vẹn SHA-256 hợp lệ.');
  }
  if (!objectKey) {
    throw new Error('Manifest trên R2 thiếu objectKey của gói cài đặt.');
  }

  const binObj = await cloudSync.r2Client.getObject(objectKey);
  if (!binObj || !binObj.body || binObj.body.length === 0) {
    throw new Error(`Không tìm thấy file thực thi "${objectKey}" trên Cloudflare R2.`);
  }

  const { targetPath, newPath, oldPath } = getSiblingExePaths(targetExePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  try {
    fs.writeFileSync(newPath, binObj.body);

    if (binObj.body.length < minBytes) {
      throw new Error(
        `Dung lượng gói cập nhật quá nhỏ (${binObj.body.length} bytes < tối thiểu ${minBytes} bytes). Hủy cập nhật để bảo vệ ứng dụng.`
      );
    }

    const actualSha = (await computeFileSha256(newPath)).toLowerCase();
    if (actualSha !== expectedSha) {
      throw new Error(
        `Xác thực toàn vẹn SHA-256 thất bại! Mong đợi ${expectedSha}, thực tế ${actualSha}. Đã xóa file tải về để đảm bảo an toàn.`
      );
    }

    if (IS_SEA && autoRestartInSea) {
      spawnWindowsSwapHelper({
        sourcePath: newPath,
        targetPath,
        backupPath: oldPath
      });
      setTimeout(() => {
        process.exit(0);
      }, 600);

      return {
        ok: true,
        applied: false,
        staged: true,
        willRestart: true,
        sha256Verified: true,
        version: manifest.version || null,
        backupPath: oldPath
      };
    }
  } catch (stageErr) {
    if (fs.existsSync(newPath)) {
      try { fs.unlinkSync(newPath); } catch {}
    }
    throw stageErr;
  }

  let backupPath = null;
  if (fs.existsSync(targetPath)) {
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch {}
    }
    fs.renameSync(targetPath, oldPath);
    backupPath = oldPath;
  }

  fs.renameSync(newPath, targetPath);

  return {
    ok: true,
    applied: true,
    willRestart: false,
    sha256Verified: true,
    version: manifest.version || null,
    backupPath
  };
}

/**
 * Restores the previous executable from the sibling .old.exe backup.
 *
 * @param {Object} [options={}]
 * @param {string} [options.targetExePath]
 * @param {boolean} [options.autoRestartInSea=true]
 */
async function rollbackUpdate({ targetExePath, autoRestartInSea = true } = {}) {
  const { targetPath, oldPath } = getSiblingExePaths(targetExePath);

  if (!fs.existsSync(oldPath) || !fs.statSync(oldPath).isFile()) {
    throw new Error(`Không tìm thấy bản sao lưu cũ để khôi phục tại: ${oldPath}`);
  }

  if (IS_SEA && autoRestartInSea) {
    spawnWindowsSwapHelper({
      sourcePath: oldPath,
      targetPath,
      backupPath: null
    });
    setTimeout(() => {
      process.exit(0);
    }, 600);

    return {
      ok: true,
      rolledBack: false,
      staged: true,
      willRestart: true,
      targetPath,
      backupPath: oldPath
    };
  }

  fs.renameSync(oldPath, targetPath);

  return {
    ok: true,
    rolledBack: true,
    willRestart: false,
    targetPath
  };
}

module.exports = {
  APP_MANIFEST_KEY,
  APP_BINARY_KEY,
  computeFileSha256,
  getDefaultExePath,
  getSiblingExePaths,
  checkForUpdate,
  publishRelease,
  downloadAndStageUpdate,
  rollbackUpdate
};
