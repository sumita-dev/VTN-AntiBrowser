/**
 * VNT-Browser Cloudflare R2 Cloud Synchronization Service (`src/core/cloud-sync.js`)
 * Zero-dependency multi-machine synchronization with S3/R2 SigV4,
 * native `tar.exe` compression, and distributed Lock Invariants.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { R2Client, DEFAULT_R2_CONFIG_PATH } = require('./r2-client');
const { BIN_DIR, DATA_DIR } = require('./paths');

const MACHINE_ID_PATH = path.join(DATA_DIR, 'machine_id.txt');

function getMachineId() {
  if (fs.existsSync(MACHINE_ID_PATH)) {
    try {
      const id = fs.readFileSync(MACHINE_ID_PATH, 'utf8').trim();
      if (id) return id;
    } catch {}
  }
  const hostname = os.hostname().replace(/[^a-zA-Z0-9_-]/g, '_');
  const rand = crypto.randomBytes(4).toString('hex');
  const newId = `${hostname}-${rand}`;
  try {
    fs.mkdirSync(path.dirname(MACHINE_ID_PATH), { recursive: true });
    fs.writeFileSync(MACHINE_ID_PATH, newId, 'utf8');
  } catch {}
  return newId;
}

class CloudSync {
  /**
   * @param {Object} [options={}]
   * @param {R2Client} [options.r2Client]
   * @param {string} [options.configPath]
   * @param {string} [options.machineId]
   * @param {number} [options.lockTtlMs=1800000] // 30 mins
   */
  constructor(options = {}) {
    this.configPath = options.configPath || DEFAULT_R2_CONFIG_PATH;
    this.r2Client = options.r2Client || R2Client.fromConfigFile(this.configPath);
    this.machineId = options.machineId || getMachineId();
    this.lockTtlMs = options.lockTtlMs || 30 * 60 * 1000;
  }

  /**
   * Reads R2 config file and returns masked credentials safe for client-side API response.
   * Never exposes raw `secretAccessKey`.
   *
   * @returns {{ enabled: boolean, endpoint: string, bucket: string, region: string, accessKeyId: string, hasSecret: boolean }}
   */
  getMaskedConfig() {
    let cfg = {
      enabled: false,
      endpoint: '',
      bucket: 'vtn-antibrowser',
      region: 'auto',
      accessKeyId: '',
      secretAccessKey: ''
    };

    if (fs.existsSync(this.configPath)) {
      try {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          cfg = { ...cfg, ...parsed };
        }
      } catch (err) {
        console.warn('[CloudSync] Warning reading config for getMaskedConfig:', err.message);
      }
    } else if (this.r2Client) {
      cfg.enabled = Boolean(this.r2Client.enabled);
      cfg.endpoint = this.r2Client.endpoint || '';
      cfg.bucket = this.r2Client.bucket || 'vtn-antibrowser';
      cfg.region = this.r2Client.region || 'auto';
      cfg.accessKeyId = this.r2Client.accessKeyId || '';
      cfg.secretAccessKey = this.r2Client.secretAccessKey || '';
    }

    return {
      enabled: cfg.enabled !== undefined ? Boolean(cfg.enabled) : false,
      endpoint: cfg.endpoint || '',
      bucket: cfg.bucket || 'vtn-antibrowser',
      region: cfg.region || 'auto',
      accessKeyId: cfg.accessKeyId || '',
      hasSecret: Boolean(cfg.secretAccessKey && String(cfg.secretAccessKey).trim().length > 0)
    };
  }

  /**
   * Validates and persists R2 configuration into data/r2_config.json,
   * retaining previous secretAccessKey if newCfg.secretAccessKey is empty/omitted,
   * and reloads the active R2Client instance.
   *
   * @param {Object} newCfg
   * @param {boolean} [newCfg.enabled]
   * @param {string} [newCfg.endpoint]
   * @param {string} [newCfg.accessKeyId]
   * @param {string} [newCfg.secretAccessKey]
   * @param {string} [newCfg.bucket]
   * @param {string} [newCfg.region]
   * @returns {{ ok: boolean, config: Object }}
   */
  saveConfig(newCfg = {}) {
    let existingCfg = {};
    if (fs.existsSync(this.configPath)) {
      try {
        existingCfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      } catch {}
    }

    const secret = (newCfg.secretAccessKey !== undefined && String(newCfg.secretAccessKey).trim().length > 0)
      ? String(newCfg.secretAccessKey).trim()
      : (existingCfg.secretAccessKey || (this.r2Client ? this.r2Client.secretAccessKey : '') || '');

    const merged = {
      enabled: newCfg.enabled !== undefined ? Boolean(newCfg.enabled) : true,
      endpoint: (newCfg.endpoint !== undefined ? String(newCfg.endpoint) : (existingCfg.endpoint || '')).trim().replace(/\/+$/, ''),
      accessKeyId: (newCfg.accessKeyId !== undefined ? String(newCfg.accessKeyId) : (existingCfg.accessKeyId || '')).trim(),
      secretAccessKey: secret,
      bucket: (newCfg.bucket !== undefined ? String(newCfg.bucket) : (existingCfg.bucket || 'vtn-antibrowser')).trim() || 'vtn-antibrowser',
      region: (newCfg.region !== undefined ? String(newCfg.region) : (existingCfg.region || 'auto')).trim() || 'auto'
    };

    if (merged.endpoint) {
      try {
        const parsedEndpoint = new URL(merged.endpoint);
        if (parsedEndpoint.protocol !== 'http:' && parsedEndpoint.protocol !== 'https:') {
          throw new Error('Giao thức endpoint không hợp lệ (chỉ hỗ trợ http: hoặc https:).');
        }
      } catch (err) {
        throw new Error(`Endpoint URL không hợp lệ: ${err.message}`);
      }
    }

    if (merged.enabled) {
      if (!merged.endpoint) {
        throw new Error('Endpoint URL không được để trống khi bật đồng bộ R2.');
      }
      if (!merged.accessKeyId) {
        throw new Error('Access Key ID không được để trống khi bật đồng bộ R2.');
      }
      if (!merged.secretAccessKey) {
        throw new Error('Secret Access Key không được để trống khi bật đồng bộ R2.');
      }
    }

    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(merged, null, 2), 'utf8');

    // Reload active R2Client instance
    this.r2Client = new R2Client(merged);

    return {
      ok: true,
      config: this.getMaskedConfig()
    };
  }

  /**
   * Exports R2 connection credentials as a single portable 1-Line Sync Key string.
   * Format: "VTN-R2-" + Base64(JSON({ endpoint, accessKeyId, secretAccessKey, bucket, region }))
   *
   * @returns {string|null}
   */
  exportSyncKey() {
    let cfg = null;
    if (fs.existsSync(this.configPath)) {
      try {
        cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      } catch {}
    }
    if (!cfg && this.r2Client && this.r2Client.isConfigured()) {
      cfg = {
        endpoint: this.r2Client.endpoint,
        accessKeyId: this.r2Client.accessKeyId,
        secretAccessKey: this.r2Client.secretAccessKey,
        bucket: this.r2Client.bucket,
        region: this.r2Client.region
      };
    }

    if (!cfg || !cfg.endpoint || !cfg.accessKeyId || !cfg.secretAccessKey) {
      return null;
    }

    const payload = {
      endpoint: String(cfg.endpoint).trim().replace(/\/+$/, ''),
      accessKeyId: String(cfg.accessKeyId).trim(),
      secretAccessKey: String(cfg.secretAccessKey).trim(),
      bucket: (cfg.bucket || 'vtn-antibrowser').trim(),
      region: (cfg.region || 'auto').trim()
    };

    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    return `VTN-R2-${b64}`;
  }

  /**
   * Imports and validates a 1-Line Sync Key string, saves configuration, and reloads R2Client.
   *
   * @param {string} syncKey
   * @returns {{ ok: boolean, config: Object }}
   */
  importSyncKey(syncKey) {
    if (!syncKey || typeof syncKey !== 'string') {
      throw new Error('Sync Key không được để trống.');
    }

    const trimmed = syncKey.trim();
    if (!trimmed.startsWith('VTN-R2-')) {
      throw new Error('Định dạng Sync Key không hợp lệ. Khóa phải bắt đầu bằng "VTN-R2-".');
    }

    const b64Part = trimmed.slice('VTN-R2-'.length).trim();
    if (!b64Part) {
      throw new Error('Nội dung mã hóa của Sync Key bị trống.');
    }

    let parsed;
    try {
      const jsonStr = Buffer.from(b64Part, 'base64').toString('utf8');
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(`Không thể giải mã Sync Key: ${e.message}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Dữ liệu Sync Key không hợp lệ.');
    }

    if (!parsed.endpoint || !parsed.accessKeyId || !parsed.secretAccessKey) {
      throw new Error('Sync Key thiếu các thông tin xác thực bắt buộc (endpoint, accessKeyId, secretAccessKey).');
    }

    return this.saveConfig({
      enabled: true,
      endpoint: parsed.endpoint,
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      bucket: parsed.bucket || 'vtn-antibrowser',
      region: parsed.region || 'auto'
    });
  }

  /**
   * Checks whether the native Chromium kernel archive exists on Cloudflare R2.
   * Key: "system/bin_151-0007.tar.gz"
   *
   * @returns {Promise<{ ok: boolean, exists: boolean, contentLength?: number, lastModified?: string, reason?: string, error?: string }>}
   */
  async hasKernelOnCloud() {
    if (!this.isEnabled()) {
      return { ok: true, exists: false, reason: 'R2 is not configured or disabled' };
    }

    try {
      const head = await this.r2Client.headObject('system/bin_151-0007.tar.gz');
      if (head && head.ok) {
        return {
          ok: true,
          exists: true,
          contentLength: head.contentLength || 0,
          lastModified: head.lastModified || null
        };
      }
      return { ok: true, exists: false };
    } catch (err) {
      return { ok: false, exists: false, error: err.message };
    }
  }

  /**
   * Compresses bin/151-0007 into tar.gz and uploads to R2 at system/bin_151-0007.tar.gz.
   *
   * @param {string} [binBaseDir]
   * @returns {Promise<{ ok: boolean, key: string, size: number, uploadedAt: string }>}
   */
  async uploadKernel(binBaseDir) {
    if (!this.isEnabled()) {
      throw new Error('Cloudflare R2 is disabled or not configured in data/r2_config.json');
    }

    const base = binBaseDir ? path.resolve(binBaseDir) : BIN_DIR;
    const kernelDir = path.resolve(base, '151-0007');

    if (!fs.existsSync(kernelDir)) {
      throw new Error(`Thư mục lõi Chromium không tồn tại tại: ${kernelDir}`);
    }

    const tempTar = path.join(os.tmpdir(), `vtn_kernel_151-0007_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.tar.gz`);

    try {
      // Compress directory "151-0007" relative to "base"
      const tarResult = spawnSync('tar.exe', ['-czf', tempTar, '-C', base, '151-0007'], { stdio: 'pipe' });
      if (tarResult.status !== 0 || !fs.existsSync(tempTar)) {
        const errMsg = tarResult.error ? tarResult.error.message : (tarResult.stderr ? tarResult.stderr.toString('utf8') : 'Unknown tar error');
        throw new Error(`Nén lõi Chromium thất bại: ${errMsg}`);
      }

      const tarBuf = fs.readFileSync(tempTar);
      await this.r2Client.putObject(
        'system/bin_151-0007.tar.gz',
        tarBuf,
        'application/gzip'
      );

      return {
        ok: true,
        key: 'system/bin_151-0007.tar.gz',
        size: tarBuf.length,
        uploadedAt: new Date().toISOString()
      };
    } finally {
      if (fs.existsSync(tempTar)) {
        try { fs.unlinkSync(tempTar); } catch {}
      }
    }
  }

  /**
   * Downloads system/bin_151-0007.tar.gz from R2 and extracts to binBaseDir/151-0007.
   *
   * @param {string} [binBaseDir]
   * @returns {Promise<{ ok: boolean, extracted: boolean, binPath: string, chromeExe: string }>}
   */
  async downloadKernel(binBaseDir) {
    if (!this.isEnabled()) {
      throw new Error('Cloudflare R2 is disabled or not configured in data/r2_config.json');
    }

    const base = binBaseDir ? path.resolve(binBaseDir) : BIN_DIR;
    fs.mkdirSync(base, { recursive: true });

    const obj = await this.r2Client.getObject('system/bin_151-0007.tar.gz');
    if (!obj || !obj.body || obj.body.length === 0) {
      throw new Error('Không tìm thấy file lõi system/bin_151-0007.tar.gz trên Cloudflare R2.');
    }

    const tempTar = path.join(os.tmpdir(), `vtn_extract_kernel_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.tar.gz`);

    try {
      fs.writeFileSync(tempTar, obj.body);
      const tarResult = spawnSync('tar.exe', ['-xzf', tempTar, '-C', base], { stdio: 'pipe' });
      if (tarResult.status !== 0) {
        const errMsg = tarResult.error ? tarResult.error.message : (tarResult.stderr ? tarResult.stderr.toString('utf8') : 'Unknown tar error');
        throw new Error(`Giải nén lõi Chromium thất bại: ${errMsg}`);
      }

      const chromeExe = path.join(base, '151-0007', 'chrome.exe');
      if (!fs.existsSync(chromeExe)) {
        throw new Error(`Sau khi giải nén, không tìm thấy chrome.exe tại: ${chromeExe}`);
      }

      return {
        ok: true,
        extracted: true,
        binPath: path.join(base, '151-0007'),
        chromeExe
      };
    } finally {
      if (fs.existsSync(tempTar)) {
        try { fs.unlinkSync(tempTar); } catch {}
      }
    }
  }

  isEnabled() {
    return Boolean(this.r2Client && this.r2Client.isConfigured());
  }

  /**
   * Checks R2 connection and returns status + profile counts.
   *
   * @returns {Promise<{ enabled: boolean, connected: boolean, bucket: string, machineId: string, profileCount: number, error?: string }>}
   */
  async getCloudStatus() {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        connected: false,
        bucket: this.r2Client ? this.r2Client.bucket : 'vtn-antibrowser',
        machineId: this.machineId,
        profileCount: 0,
        message: 'Cloudflare R2 is disabled or not configured in data/r2_config.json'
      };
    }

    try {
      const objects = await this.r2Client.listObjects('profiles/');
      const profileIds = new Set();
      for (const obj of objects) {
        const m = obj.key.match(/^profiles\/([^/]+)\/meta\.json$/);
        if (m) {
          profileIds.add(m[1]);
        }
      }

      return {
        ok: true,
        enabled: true,
        connected: true,
        bucket: this.r2Client.bucket,
        machineId: this.machineId,
        profileCount: profileIds.size,
        profileIds: Array.from(profileIds)
      };
    } catch (err) {
      return {
        ok: false,
        enabled: true,
        connected: false,
        bucket: this.r2Client.bucket,
        machineId: this.machineId,
        profileCount: 0,
        error: err.message
      };
    }
  }

  /**
   * Checks if a profile is currently locked on R2 by another machine.
   *
   * @param {string} profileId
   * @returns {Promise<{ locked: boolean, machineId?: string, lockedAt?: string, isOwnLock?: boolean, expired?: boolean }>}
   */
  async isLocked(profileId) {
    if (!this.isEnabled()) return { locked: false };

    try {
      const lockRes = await this.r2Client.getObject(`profiles/${profileId}/lock.json`);
      if (!lockRes) {
        return { locked: false };
      }

      const lock = JSON.parse(lockRes.body.toString('utf8'));
      const lockedAt = new Date(lock.lockedAt).getTime();
      const now = Date.now();

      // If lock has exceeded TTL, treat as expired
      if (now - lockedAt > this.lockTtlMs) {
        return {
          locked: false,
          expired: true,
          previousLock: lock
        };
      }

      if (lock.machineId === this.machineId) {
        return {
          locked: false,
          isOwnLock: true,
          lockInfo: lock
        };
      }

      return {
        locked: true,
        machineId: lock.machineId,
        lockedAt: lock.lockedAt,
        lockInfo: lock
      };
    } catch (err) {
      console.warn(`[CloudSync] Warning checking lock for ${profileId}:`, err.message);
      throw err;
    }
  }

  /**
   * Acquires distributed lock for a profile.
   *
   * @param {string} profileId
   * @param {string} [machineId=this.machineId]
   * @returns {Promise<{ ok: boolean, profileId: string, machineId: string, lockedAt: string, degradedOffline?: boolean, error?: string }>}
   */
  async acquireLock(profileId, machineId = this.machineId) {
    if (!this.isEnabled()) return { ok: true, bypassed: true };

    try {
      const lockStatus = await this.isLocked(profileId);
      if (lockStatus.locked) {
        throw new Error(
          `Profile "${profileId}" đang được mở bởi máy "${lockStatus.machineId}" (từ ${lockStatus.lockedAt}). Không thể mở đồng thời để bảo vệ dữ liệu.`
        );
      }

      const lockPayload = {
        machineId,
        profileId,
        lockedAt: new Date().toISOString(),
        ttlMs: this.lockTtlMs
      };

      await this.r2Client.putObject(
        `profiles/${profileId}/lock.json`,
        JSON.stringify(lockPayload, null, 2),
        'application/json'
      );

      return {
        ok: true,
        profileId,
        machineId,
        lockedAt: lockPayload.lockedAt
      };
    } catch (err) {
      if (err.message && err.message.includes('đang được mở bởi máy')) {
        throw err;
      }
      console.warn(`[CloudSync] Warning acquiring lock for ${profileId} (offline degradation):`, err.message);
      return {
        ok: true,
        degradedOffline: true,
        error: err.message
      };
    }
  }

  /**
   * Releases distributed lock for a profile.
   *
   * @param {string} profileId
   * @returns {Promise<{ ok: boolean, profileId: string, reason?: string }>}
   */
  async releaseLock(profileId) {
    if (!this.isEnabled()) return { ok: true, bypassed: true };

    try {
      const lockRes = await this.r2Client.getObject(`profiles/${profileId}/lock.json`);
      if (lockRes) {
        try {
          const lock = JSON.parse(lockRes.body.toString('utf8'));
          if (lock && lock.machineId && lock.machineId !== this.machineId) {
            console.warn(
              `[CloudSync] Cannot release lock for ${profileId}: lock is currently owned by "${lock.machineId}", not this machine ("${this.machineId}").`
            );
            return { ok: false, reason: 'lock_owned_by_another' };
          }
        } catch (parseErr) {
          console.warn(`[CloudSync] Could not parse existing lock JSON for ${profileId}:`, parseErr.message);
        }
      }

      await this.r2Client.deleteObject(`profiles/${profileId}/lock.json`);
    } catch (err) {
      console.error(`[CloudSync] Error releasing lock for ${profileId}:`, err.message);
    }

    return { ok: true, profileId };
  }

  /**
   * Compresses profile data excluding volatile caches and uploads to Cloudflare R2
   * along with metadata from SQLite.
   *
   * @param {string} profileId
   * @param {Object} db
   * @param {string} profilesDir
   * @returns {Promise<{ ok: boolean, profileId: string, size?: number, uploadedAt: string }>}
   */
  async uploadProfileData(profileId, db, profilesDir) {
    if (!this.isEnabled()) return { ok: false, error: 'Cloudflare R2 is not enabled' };

    const idStr = String(profileId);
    const pDir = path.resolve(profilesDir, idStr);

    // 1. Upload profile meta from SQLite DB
    if (db) {
      const profile = db.getProfile(idStr);
      if (profile) {
        await this.r2Client.putObject(
          `profiles/${idStr}/meta.json`,
          JSON.stringify(profile, null, 2),
          'application/json'
        );
      }
    }

    // 2. Compress and upload directory if it exists on disk
    let uploadedSize = 0;
    if (fs.existsSync(pDir)) {
      const tempTar = path.join(os.tmpdir(), `vnt_sync_${idStr}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.tar.gz`);
      try {
        const tarArgs = [
          '-czf',
          tempTar,
          '--exclude=*Cache*',
          '--exclude=*Crashpad*',
          '--exclude=Singleton*',
          '--exclude=*lock*',
          '--exclude=*Lock*',
          '--exclude=*LOCK*',
          '--exclude=*journal*',
          '--exclude=*.tmp',
          '-C',
          pDir,
          '.'
        ];

        const tarResult = spawnSync('tar.exe', tarArgs, { stdio: 'pipe' });
        if (tarResult.status === 0 && fs.existsSync(tempTar)) {
          const tarBuf = fs.readFileSync(tempTar);
          uploadedSize = tarBuf.length;
          await this.r2Client.putObject(
            `profiles/${idStr}/data.tar.gz`,
            tarBuf,
            'application/gzip'
          );
        } else {
          console.error(`[CloudSync] tar creation failed for ${idStr}:`, tarResult.stderr ? tarResult.stderr.toString() : 'Unknown error');
        }
      } finally {
        if (fs.existsSync(tempTar)) {
          try { fs.unlinkSync(tempTar); } catch {}
        }
      }
    }

    return {
      ok: true,
      profileId: idStr,
      size: uploadedSize,
      uploadedAt: new Date().toISOString()
    };
  }

  /**
   * Downloads profile data archive from Cloudflare R2 and extracts to disk.
   * If local SQLite does not have this profile, imports from meta.json.
   *
   * @param {string} profileId
   * @param {Object} db
   * @param {string} profilesDir
   * @returns {Promise<{ ok: boolean, profileId: string, profileMeta?: Object, extracted: boolean }>}
   */
  async downloadProfileData(profileId, db, profilesDir) {
    if (!this.isEnabled()) return { ok: false, error: 'Cloudflare R2 is not enabled' };

    const idStr = String(profileId);
    const pDir = path.resolve(profilesDir, idStr);
    let profileMeta = null;

    // 1. Download meta.json and sync into SQLite if missing
    try {
      const metaRes = await this.r2Client.getObject(`profiles/${idStr}/meta.json`);
      if (metaRes) {
        profileMeta = JSON.parse(metaRes.body.toString('utf8'));
        if (db) {
          const existing = db.getProfile(idStr);
          if (!existing && typeof db.upsertProfileFromCloud === 'function') {
            db.upsertProfileFromCloud(profileMeta);
          }
        }
      }
    } catch (err) {
      console.error(`[CloudSync] Error fetching meta.json for ${idStr}:`, err.message);
    }

    // 2. Download data.tar.gz and extract
    let extracted = false;
    try {
      const dataRes = await this.r2Client.getObject(`profiles/${idStr}/data.tar.gz`);
      if (dataRes && dataRes.body && dataRes.body.length > 0) {
        const tempTar = path.join(os.tmpdir(), `vnt_extract_${idStr}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.tar.gz`);
        try {
          fs.writeFileSync(tempTar, dataRes.body);
          fs.mkdirSync(pDir, { recursive: true });

          const tarResult = spawnSync('tar.exe', ['-xzf', tempTar, '-C', pDir], { stdio: 'pipe' });
          if (tarResult.status === 0) {
            extracted = true;
          } else {
            console.error(`[CloudSync] tar extract failed for ${idStr}:`, tarResult.stderr ? tarResult.stderr.toString() : 'Unknown error');
          }
        } finally {
          if (fs.existsSync(tempTar)) {
            try { fs.unlinkSync(tempTar); } catch {}
          }
        }
      }
    } catch (err) {
      console.error(`[CloudSync] Error fetching data.tar.gz for ${idStr}:`, err.message);
    }

    return {
      ok: true,
      profileId: idStr,
      profileMeta,
      extracted
    };
  }

  /**
   * Scans all profiles on R2 cloud, downloads metadata for any profiles missing
   * in the local SQLite database, and optionally downloads profile data archives.
   *
   * @param {Object} db
   * @param {string} profilesDir
   * @returns {Promise<{ ok: boolean, totalCloudProfiles: number, newSyncedProfiles: number, profiles: Array }>}
   */
  async syncAllProfiles(db, profilesDir) {
    if (!this.isEnabled()) return { ok: false, error: 'Cloudflare R2 is not enabled' };

    const objects = await this.r2Client.listObjects('profiles/');
    const metaObjects = objects.filter((o) => o.key.match(/^profiles\/([^/]+)\/meta\.json$/));

    let newSyncedProfiles = 0;
    const syncedList = [];

    for (const obj of metaObjects) {
      const m = obj.key.match(/^profiles\/([^/]+)\/meta\.json$/);
      if (!m) continue;
      const profileId = m[1];

      try {
        const existing = db ? db.getProfile(profileId) : null;
        if (!existing) {
          // New profile on this machine: download meta and data
          const dlResult = await this.downloadProfileData(profileId, db, profilesDir);
          if (dlResult.ok) {
            newSyncedProfiles++;
            syncedList.push({ profileId, name: dlResult.profileMeta ? dlResult.profileMeta.name : profileId, isNew: true });
          }
        } else {
          syncedList.push({ profileId, name: existing.name, isNew: false });
        }
      } catch (err) {
        console.error(`[CloudSync] Failed to sync profile ${profileId}:`, err.message);
      }
    }

    return {
      ok: true,
      totalCloudProfiles: metaObjects.length,
      newSyncedProfiles,
      profiles: syncedList
    };
  }
}

module.exports = {
  CloudSync,
  getMachineId
};
