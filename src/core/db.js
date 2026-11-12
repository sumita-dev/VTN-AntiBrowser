/**
 * VNT-Browser SQLite Database Layer (`src/core/db.js`)
 * Uses Node.js built-in `node:sqlite` (`DatabaseSync`) for zero-external-dependency persistence.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { generateFingerprint, generateUniqueFingerprint, validateAndHealFingerprint } = require('./fingerprint-gen');

const DEFAULT_DB_PATH = path.resolve(__dirname, '..', '..', 'data', 'vnt_profiles.db');

class ProfileDatabase {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  initSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        group_name TEXT DEFAULT 'Default',
        tags TEXT DEFAULT '[]',
        notes TEXT DEFAULT '',
        proxy_config TEXT DEFAULT '{"mode":"direct"}',
        auto_geoip INTEGER DEFAULT 0,
        start_url TEXT DEFAULT 'about:blank',
        fingerprint_json TEXT NOT NULL,
        cookies_json TEXT DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_opened_at TEXT DEFAULT NULL
      );
    `);
  }

  listProfiles() {
    const stmt = this.db.prepare('SELECT * FROM profiles ORDER BY created_at DESC');
    const rows = stmt.all();
    return rows.map((r) => this._deserializeRow(r));
  }

  getProfile(id) {
    const stmt = this.db.prepare('SELECT * FROM profiles WHERE id = ?');
    const row = stmt.get(String(id));
    return row ? this._deserializeRow(row) : null;
  }

  createProfile(payload = {}) {
    const id = payload.id || `vnt_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const name = payload.name || `Profile ${id.slice(-4).toUpperCase()}`;
    const groupName = payload.groupName || payload.group_name || 'Default';
    const tags = Array.isArray(payload.tags) ? payload.tags : [];
    const notes = payload.notes || '';
    const proxyConfig = payload.proxyConfig || payload.proxy_config || { mode: 'direct' };
    const autoGeoIp = payload.autoGeoIp !== undefined ? (payload.autoGeoIp ? 1 : 0) : 0;
    const startUrl = payload.startUrl || payload.start_url || 'about:blank';

    const existingProfiles = this.listProfiles();
    let fp;
    if (payload.fingerprint) {
      fp = validateAndHealFingerprint(payload.fingerprint).fp;
    } else if (payload.ensureUnique !== false) {
      fp = generateUniqueFingerprint(payload.fingerprintOverrides || {}, existingProfiles);
    } else {
      fp = generateFingerprint(payload.fingerprintOverrides || {});
    }

    if (startUrl && fp.staticConfig) {
      fp.staticConfig.NewTabURL = startUrl;
    }

    const cookies = Array.isArray(payload.cookies) ? payload.cookies : [];

    const stmt = this.db.prepare(`
      INSERT INTO profiles (
        id, name, group_name, tags, notes, proxy_config,
        auto_geoip, start_url, fingerprint_json, cookies_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      name,
      groupName,
      JSON.stringify(tags),
      notes,
      JSON.stringify(proxyConfig),
      autoGeoIp,
      startUrl,
      JSON.stringify(fp),
      JSON.stringify(cookies),
      now,
      now
    );

    return this.getProfile(id);
  }

  updateProfile(id, patch = {}) {
    const existing = this.getProfile(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const name = patch.name !== undefined ? patch.name : existing.name;
    const groupName = patch.groupName !== undefined ? patch.groupName : existing.groupName;
    const tags = patch.tags !== undefined ? patch.tags : existing.tags;
    const notes = patch.notes !== undefined ? patch.notes : existing.notes;
    const proxyConfig = patch.proxyConfig !== undefined ? patch.proxyConfig : existing.proxyConfig;
    const autoGeoIp = patch.autoGeoIp !== undefined ? (patch.autoGeoIp ? 1 : 0) : (existing.autoGeoIp ? 1 : 0);
    const startUrl = patch.startUrl !== undefined ? patch.startUrl : existing.startUrl;
    const cookies = patch.cookies !== undefined ? patch.cookies : existing.cookies;

    let fp = existing.fingerprint;
    if (patch.fingerprint) {
      fp = patch.fingerprint;
    } else if (patch.fingerprintOverrides) {
      fp = generateFingerprint(patch.fingerprintOverrides);
    }
    if (startUrl && fp && fp.staticConfig) {
      fp.staticConfig.NewTabURL = startUrl;
    }

    const stmt = this.db.prepare(`
      UPDATE profiles
      SET name = ?, group_name = ?, tags = ?, notes = ?, proxy_config = ?,
          auto_geoip = ?, start_url = ?, fingerprint_json = ?, cookies_json = ?,
          updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      name,
      groupName,
      JSON.stringify(tags),
      notes,
      JSON.stringify(proxyConfig),
      autoGeoIp,
      startUrl,
      JSON.stringify(fp),
      JSON.stringify(cookies),
      now,
      String(id)
    );

    return this.getProfile(id);
  }

  markOpened(id) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE profiles SET last_opened_at = ?, updated_at = ? WHERE id = ?');
    stmt.run(now, now, String(id));
  }

  deleteProfile(id) {
    const stmt = this.db.prepare('DELETE FROM profiles WHERE id = ?');
    const info = stmt.run(String(id));
    return info.changes > 0;
  }

  upsertProfileFromCloud(meta) {
    if (!meta || !meta.id) return null;
    const stmt = this.db.prepare(`
      INSERT INTO profiles (
        id, name, group_name, tags, notes, proxy_config,
        auto_geoip, start_url, fingerprint_json, cookies_json,
        created_at, updated_at, last_opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        group_name = excluded.group_name,
        tags = excluded.tags,
        notes = excluded.notes,
        proxy_config = excluded.proxy_config,
        auto_geoip = excluded.auto_geoip,
        start_url = excluded.start_url,
        fingerprint_json = excluded.fingerprint_json,
        cookies_json = excluded.cookies_json,
        updated_at = excluded.updated_at,
        last_opened_at = excluded.last_opened_at
    `);

    stmt.run(
      String(meta.id),
      meta.name || `Profile ${meta.id}`,
      meta.groupName || meta.group_name || 'Default',
      typeof meta.tags === 'string' ? meta.tags : JSON.stringify(meta.tags || []),
      meta.notes || '',
      typeof meta.proxyConfig === 'string' ? meta.proxyConfig : JSON.stringify(meta.proxyConfig || meta.proxy_config || { mode: 'direct' }),
      meta.autoGeoIp ? 1 : 0,
      meta.startUrl || meta.start_url || 'about:blank',
      typeof meta.fingerprint === 'string' ? meta.fingerprint : JSON.stringify(meta.fingerprint || {}),
      typeof meta.cookies === 'string' ? meta.cookies : JSON.stringify(meta.cookies || []),
      meta.createdAt || meta.created_at || new Date().toISOString(),
      meta.updatedAt || meta.updated_at || new Date().toISOString(),
      meta.lastOpenedAt || meta.last_opened_at || null
    );

    return this.getProfile(meta.id);
  }

  _deserializeRow(row) {
    const safeJson = (val, fallback) => {
      try { return JSON.parse(val); } catch { return fallback; }
    };
    return {
      id: row.id,
      name: row.name,
      groupName: row.group_name,
      tags: safeJson(row.tags, []),
      notes: row.notes || '',
      proxyConfig: safeJson(row.proxy_config, { mode: 'direct' }),
      autoGeoIp: Boolean(row.auto_geoip),
      startUrl: row.start_url || 'about:blank',
      fingerprint: safeJson(row.fingerprint_json, {}),
      cookies: safeJson(row.cookies_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: row.last_opened_at
    };
  }
}

module.exports = {
  ProfileDatabase,
  DEFAULT_DB_PATH
};
