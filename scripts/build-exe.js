/**
 * VTN Anti-Browser Single Executable Application (SEA) Builder (`scripts/build-exe.js`)
 * Bundles `src/main.js` with esbuild, embeds `src/ui/` assets into `dist/sea-prep.blob`,
 * copies the Node.js runtime to `dist/VTN-Anti-Browser.exe`, and injects the SEA blob.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const UI_DIR = path.join(ROOT_DIR, 'src', 'ui');
const BUNDLE_PATH = path.join(DIST_DIR, 'bundle.cjs');
const SEA_CONFIG_PATH = path.join(DIST_DIR, 'sea-config.json');
const SEA_BLOB_PATH = path.join(DIST_DIR, 'sea-prep.blob');
const EXE_PATH = path.join(DIST_DIR, 'VTN-Anti-Browser.exe');
const TMP_EXE_PATH = path.join(DIST_DIR, 'VTN-Anti-Browser.tmp.exe');
const FAVICON_ICO_PATH = path.join(UI_DIR, 'favicon.ico');

const NPX_CMD = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function runStep(label, cmd, args, opts = {}) {
  log(`\n[build:exe] ${label}...`);
  const res = spawnSync(cmd, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    shell: false,
    ...opts
  });
  if (res.error) {
    throw new Error(`${label} failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(`${label} exited with code ${res.status}`);
  }
}

function collectUiAssets(dir, baseDir = dir, assets = {}) {
  if (!fs.existsSync(dir)) return assets;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectUiAssets(fullPath, baseDir, assets);
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      const assetKey = `ui/${rel}`;
      const assetPath = path.relative(ROOT_DIR, fullPath).replace(/\\/g, '/');
      assets[assetKey] = assetPath;
    }
  }
  return assets;
}

function main() {
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 1. Bundle src/main.js -> dist/bundle.cjs
  runStep('Bundling src/main.js with esbuild', NPX_CMD, [
    '--yes',
    'esbuild',
    'src/main.js',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:node:sqlite',
    '--external:node:sea',
    `--outfile=${path.relative(ROOT_DIR, BUNDLE_PATH).replace(/\\/g, '/')}`
  ], { shell: process.platform === 'win32' });

  // 2. Scan src/ui/ and write dist/sea-config.json
  const assets = collectUiAssets(UI_DIR);
  const seaConfig = {
    main: path.relative(ROOT_DIR, BUNDLE_PATH).replace(/\\/g, '/'),
    output: path.relative(ROOT_DIR, SEA_BLOB_PATH).replace(/\\/g, '/'),
    disableExperimentalSEAWarning: true,
    assets
  };
  fs.writeFileSync(SEA_CONFIG_PATH, JSON.stringify(seaConfig, null, 2), 'utf8');
  log(`[build:exe] Generated sea-config.json with ${Object.keys(assets).length} UI assets.`);

  // 3. Generate SEA preparation blob
  runStep('Generating SEA blob', process.execPath, [
    '--experimental-sea-config',
    path.relative(ROOT_DIR, SEA_CONFIG_PATH).replace(/\\/g, '/')
  ]);

  // 4. Copy Node.js binary -> dist/VTN-Anti-Browser.tmp.exe (atomic staging)
  log(`\n[build:exe] Copying Node.js runtime (${process.execPath}) -> ${TMP_EXE_PATH}...`);
  fs.copyFileSync(process.execPath, TMP_EXE_PATH);

  // 5. Optionally set Windows icon with rcedit before injecting SEA blob (non-fatal if unavailable)
  if (process.platform === 'win32' && fs.existsSync(FAVICON_ICO_PATH)) {
    try {
      log('\n[build:exe] Attempting to set .exe icon via rcedit (optional)...');
      const rceditRes = spawnSync(NPX_CMD, [
        '--yes',
        'rcedit',
        path.relative(ROOT_DIR, TMP_EXE_PATH).replace(/\\/g, '/'),
        '--set-icon',
        path.relative(ROOT_DIR, FAVICON_ICO_PATH).replace(/\\/g, '/')
      ], {
        cwd: ROOT_DIR,
        stdio: 'pipe',
        shell: true,
        timeout: 30000
      });
      if (rceditRes.status === 0) {
        log('[build:exe] Icon applied successfully via rcedit.');
      } else {
        log('[build:exe] Skipping icon embedding (rcedit unavailable or failed).');
      }
    } catch {
      log('[build:exe] Skipping icon embedding (rcedit unavailable).');
    }
  }

  // 6. Inject SEA blob into temporary executable via postject
  runStep('Injecting SEA blob with postject', NPX_CMD, [
    '--yes',
    'postject',
    path.relative(ROOT_DIR, TMP_EXE_PATH).replace(/\\/g, '/'),
    'NODE_SEA_BLOB',
    path.relative(ROOT_DIR, SEA_BLOB_PATH).replace(/\\/g, '/'),
    '--sentinel-fuse',
    SENTINEL_FUSE
  ], { shell: process.platform === 'win32' });

  // 7. Verify SEA blob injection increased binary size before atomic rename
  const nodeSize = fs.statSync(process.execPath).size;
  const tmpSize = fs.statSync(TMP_EXE_PATH).size;
  if (tmpSize <= nodeSize) {
    throw new Error(
      `SEA blob injection verification failed: ${TMP_EXE_PATH} size (${tmpSize} bytes) <= node.exe size (${nodeSize} bytes).`
    );
  }

  fs.renameSync(TMP_EXE_PATH, EXE_PATH);

  const stat = fs.statSync(EXE_PATH);
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  log(`\n[build:exe] SUCCESS: Built ${EXE_PATH} (${sizeMb} MB)`);
}

main();
