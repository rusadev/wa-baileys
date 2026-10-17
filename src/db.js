import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('super_admin', 'admin')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    api_key TEXT NOT NULL UNIQUE,
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'disconnected',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    sess TEXT NOT NULL,
    expired INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_devices_api_key ON devices(api_key);
  CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
`);

/** Lightweight additive migrations for existing SQLite files. */
const deviceColumns = db.prepare(`PRAGMA table_info(devices)`).all().map((c) => c.name);
if (!deviceColumns.includes('webhook_url')) {
  db.exec(`ALTER TABLE devices ADD COLUMN webhook_url TEXT`);
}
if (!deviceColumns.includes('webhook_secret')) {
  db.exec(`ALTER TABLE devices ADD COLUMN webhook_secret TEXT`);
}

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

export function findUserByEmail(email) {
  return db
    .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
    .get(email);
}

export function findUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function createUser({ id, email, passwordHash, name, role }) {
  db.prepare(
    `INSERT INTO users (id, email, password_hash, name, role)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, email, passwordHash, name, role);
  return findUserById(id);
}

export function listUsers() {
  return db
    .prepare(
      `SELECT id, email, name, role, created_at FROM users ORDER BY created_at ASC`
    )
    .all();
}

export function updateUser(id, fields) {
  const allowed = ['name', 'email', 'password_hash', 'role'];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(fields[key]);
    }
  }
  if (!sets.length) return findUserById(id);
  vals.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return findUserById(id);
}

export function deleteUser(id) {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function listDevices({ ownerUserId = null, all = false } = {}) {
  if (all || !ownerUserId) {
    return db
      .prepare(
        `SELECT d.*, u.email AS owner_email, u.name AS owner_name
         FROM devices d
         JOIN users u ON u.id = d.owner_user_id
         ORDER BY d.created_at ASC`
      )
      .all();
  }
  return db
    .prepare(
      `SELECT d.*, u.email AS owner_email, u.name AS owner_name
       FROM devices d
       JOIN users u ON u.id = d.owner_user_id
       WHERE d.owner_user_id = ?
       ORDER BY d.created_at ASC`
    )
    .all(ownerUserId);
}

export function findDeviceById(id) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}

export function findDeviceByApiKey(apiKey) {
  return db.prepare('SELECT * FROM devices WHERE api_key = ?').get(apiKey);
}

export function createDevice({ id, name, ownerUserId, apiKey }) {
  db.prepare(
    `INSERT INTO devices (id, name, owner_user_id, api_key, status)
     VALUES (?, ?, ?, ?, 'disconnected')`
  ).run(id, name, ownerUserId, apiKey);
  return findDeviceById(id);
}

export function updateDevice(id, fields) {
  const allowed = [
    'name',
    'api_key',
    'phone',
    'status',
    'owner_user_id',
    'webhook_url',
    'webhook_secret',
  ];
  const sets = [];
  const vals = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(fields[key]);
    }
  }
  if (!sets.length) return findDeviceById(id);
  vals.push(id);
  db.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return findDeviceById(id);
}

export function deleteDevice(id) {
  return db.prepare('DELETE FROM devices WHERE id = ?').run(id);
}

export function getSessionStore() {
  return {
    get(sid) {
      const row = db
        .prepare('SELECT sess, expired FROM sessions WHERE sid = ?')
        .get(sid);
      if (!row) return null;
      if (row.expired < Date.now()) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return null;
      }
      return JSON.parse(row.sess);
    },
    set(sid, sess, maxAgeMs) {
      const expired = Date.now() + (maxAgeMs || 86400000);
      db.prepare(
        `INSERT INTO sessions (sid, sess, expired) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expired = excluded.expired`
      ).run(sid, JSON.stringify(sess), expired);
    },
    destroy(sid) {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    },
    touch(sid, sess, maxAgeMs) {
      this.set(sid, sess, maxAgeMs);
    },
  };
}

export { db, DATA_DIR, ROOT };
