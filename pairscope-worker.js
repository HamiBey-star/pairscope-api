// PairScope API: Helius webhook payment confirmation + D1 featured listings.
// Needs: D1 binding named DB, vars TREASURY and ALLOWED_ORIGIN, secret HELIUS_WEBHOOK_SECRET.

const ORDER_TTL = 30 * 60;
const now = () => Math.floor(Date.now() / 1000);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    days INTEGER NOT NULL,
    lamports INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    chain TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    lamports INTEGER NOT NULL,
    reference TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',
    paid_signature TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders(status, reference),
  `CREATE TABLE IF NOT EXISTS payments (
    signature TEXT PRIMARY KEY,
    order_id TEXT,
    lamports INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    token TEXT NOT NULL,
    chain TEXT NOT NULL,
    payment_signature TEXT NOT NULL UNIQUE,
    starts_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0
  )`,
  CREATE INDEX IF NOT EXISTS idx_listings_active ON listings(expires_at, hidden),
  CREATE INDEX IF NOT EXISTS idx_listings_token ON listings(token, chain, expires_at),
  `INSERT OR IGNORE INTO plans (id, days, lamports) VALUES
    ('1d', 1, 100000000), ('7d', 7, 500000000), ('30d', 30, 1500000000)`,
];

let schem
