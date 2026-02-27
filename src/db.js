const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("./config");

const dbDir = path.dirname(config.databasePath);
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  short_id TEXT UNIQUE,
  public_token TEXT NOT NULL UNIQUE,
  amount_usd REAL NOT NULL,
  allowed_currencies TEXT NOT NULL,
  exchange_snapshot TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  telegram_user_id TEXT,
  created_by_admin_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  short_id TEXT UNIQUE,
  invoice_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  network TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  expected_amount_crypto REAL NOT NULL,
  paid_amount_crypto REAL,
  tx_hash TEXT,
  confirmations INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_telegram_status ON invoices (telegram_user_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_expires_status ON invoices (expires_at, status);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_id ON payments (invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_tx_hash_unique ON payments (tx_hash) WHERE tx_hash IS NOT NULL;
`);

function hasColumn(tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function ensureColumn(tableName, columnName, sqlType) {
  if (hasColumn(tableName, columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlType}`);
}

function runMigrations() {
  ensureColumn("invoices", "short_id", "TEXT");
  ensureColumn("payments", "short_id", "TEXT");

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_short_id_unique
      ON invoices (short_id) WHERE short_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_short_id_unique
      ON payments (short_id) WHERE short_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_events_entity_created
      ON events (entity_type, entity_id, created_at DESC);
  `);
}

runMigrations();

function nowIso() {
  return new Date().toISOString();
}

function toJson(value) {
  return JSON.stringify(value || null);
}

function fromJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function logEvent(entityType, entityId, action, payload) {
  db.prepare(
    `
      INSERT INTO events (entity_type, entity_id, action, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `,
  ).run(entityType, entityId, action, toJson(payload), nowIso());
}

module.exports = {
  db,
  nowIso,
  toJson,
  fromJson,
  logEvent,
};
