const { Database } = require('node-sqlite3-wasm');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'cafe.db');
const lockPath = dbPath + '.lock';
try { fs.rmdirSync(lockPath); } catch (_) {}

const db = new Database(dbPath);
db.exec('PRAGMA foreign_keys = ON');

// Shim: make prepare() accept spread args like better-sqlite3
// node-sqlite3-wasm requires an array; better-sqlite3 accepts spread
const _prep = db.prepare.bind(db);
db.prepare = (sql) => {
  const stmt = _prep(sql);
  const norm = (args) => {
    if (args.length === 0) return [];
    if (args.length === 1) return args[0];
    return Array.from(args);
  };
  const origRun = stmt.run.bind(stmt);
  const origGet = stmt.get.bind(stmt);
  const origAll = stmt.all.bind(stmt);
  stmt.run = (...args) => origRun(norm(args));
  stmt.get = (...args) => origGet(norm(args));
  stmt.all = (...args) => origAll(norm(args));
  return stmt;
};

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','location_manager','worker')),
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    min_hours_per_month REAL NOT NULL DEFAULT 0,
    start_date DATE NOT NULL,
    end_date DATE,
    active INTEGER DEFAULT 1,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS shift_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    color TEXT DEFAULT '#3B82F6',
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start DATE NOT NULL UNIQUE,
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected')),
    created_by INTEGER REFERENCES users(id),
    approved_by INTEGER REFERENCES users(id),
    rejection_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS schedule_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    shift_template_id INTEGER REFERENCES shift_templates(id),
    custom_start TEXT,
    custom_end TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(schedule_id, user_id, date)
  );

  CREATE TABLE IF NOT EXISTS availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('available','unavailable')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, date)
  );
`);

// Migration: rename min_hours_per_week to min_hours_per_month for existing databases
try {
  const cols = db.prepare('PRAGMA table_info(contracts)').all();
  if (cols.some(c => c.name === 'min_hours_per_week')) {
    db.exec('ALTER TABLE contracts RENAME COLUMN min_hours_per_week TO min_hours_per_month');
  }
} catch (_) {}

// Migration: add modified_by_admin + modified_by_user_id to schedule_entries
try {
  const seCols = db.prepare('PRAGMA table_info(schedule_entries)').all();
  if (!seCols.some(c => c.name === 'modified_by_admin')) {
    db.exec('ALTER TABLE schedule_entries ADD COLUMN modified_by_admin INTEGER DEFAULT 0');
  }
  if (!seCols.some(c => c.name === 'modified_by_user_id')) {
    db.exec('ALTER TABLE schedule_entries ADD COLUMN modified_by_user_id INTEGER');
  }
} catch (_) {}

// Migration: add availability_locked to users
try {
  const uCols = db.prepare('PRAGMA table_info(users)').all();
  if (!uCols.some(c => c.name === 'availability_locked')) {
    db.exec('ALTER TABLE users ADD COLUMN availability_locked INTEGER DEFAULT 0');
  }
} catch (_) {}

// Migration: add start_time/end_time to availability
try {
  const avCols = db.prepare('PRAGMA table_info(availability)').all();
  if (!avCols.some(c => c.name === 'start_time')) {
    db.exec('ALTER TABLE availability ADD COLUMN start_time TEXT');
    db.exec('ALTER TABLE availability ADD COLUMN end_time TEXT');
  }
} catch (_) {}

// Migration: add hourly_rate to contracts
try {
  const cCols = db.prepare('PRAGMA table_info(contracts)').all();
  if (!cCols.some(c => c.name === 'hourly_rate')) {
    db.exec('ALTER TABLE contracts ADD COLUMN hourly_rate REAL');
  }
} catch (_) {}

// Migration: create activity_logs table
try {
  db.exec(`CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    user_name TEXT NOT NULL,
    user_role TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
} catch (_) {}

const adminExists = db.prepare('SELECT id FROM users WHERE role = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(`INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)`).run(
    'Administrator', 'admin@cafe.com', hash, 'admin'
  );

  const templates = [
    { name: 'Zmiana 1 (Rano)', start: '07:00', end: '15:00', color: '#3B82F6' },
    { name: 'Zmiana 2 (Popołudnie)', start: '12:00', end: '19:00', color: '#8B5CF6' },
    { name: 'Zmiana 3 (Krótka)', start: '11:00', end: '15:00', color: '#10B981' },
    { name: 'Zmiana 4 (Wieczór)', start: '15:00', end: '23:00', color: '#F59E0B' },
  ];
  const insertTmpl = db.prepare(`INSERT INTO shift_templates (name, start_time, end_time, color) VALUES (?,?,?,?)`);
  for (const t of templates) insertTmpl.run(t.name, t.start, t.end, t.color);

  console.log('✓ Domyślne konto: admin@cafe.com / admin123');
}

module.exports = db;
