// PairScope API: Helius webhook payment confirmation + D1 featured listings.
// Needs: D1 binding named DB, vars TREASURY and ALLOWED_ORIGIN, secret HELIUS_WEBHOOK_SECRET.
// This file contains no backtick characters on purpose.

const ORDER_TTL = 30 * 60; // pending orders live 30 minutes
const now = () => Math.floor(Date.now() / 1000);

// ---------- database schema (auto-created on first request) ----------
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, days INTEGER NOT NULL, lamports INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, token TEXT NOT NULL, chain TEXT NOT NULL, plan_id TEXT NOT NULL, lamports INTEGER NOT NULL, reference TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending', paid_signature TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_orders_pending ON orders(status, reference)",
  "CREATE TABLE IF NOT EXISTS payments (signature TEXT PRIMARY KEY, order_id TEXT, lamports INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS listings (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, token TEXT NOT NULL, chain TEXT NOT NULL, payment_signature TEXT NOT NULL UNIQUE, starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS idx_listings_active ON listings(expires_at, hidden)",
  "CREATE INDEX IF NOT EXISTS idx_listings_token ON listings(token, chain, expires_at)",
  // Placeholder prices (0.1 / 0.5 / 1.5 SOL). Change these to your real plans.
  "INSERT OR IGNORE INTO plans (id, days, lamports) VALUES ('1d', 1, 100000000), ('7d', 7, 500000000), ('30d', 30, 1500000000)"
];

let schemaReady = null;
function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
      schemaReady = null; // retry on next request
      throw err;
    });
  }
  return schemaReady;
}

// ---------- helpers ----------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of bytes) { if (b === 0) out += "1"; else break; }
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

function newReference() {
  // Any 32 random bytes is a valid read-only account key (Solana Pay style reference).
  return base58(crypto.getRandomValues(new Uint8Array(32)));
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a || "");
  const y = enc.encode(b || "");
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function json(data, env, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, cors(env))
  });
}

// ---------- pre-payment checks (stub) ----------
// Plug in DexScreener liquidity + GoPlus scan here so bad tokens are declined BEFORE payment.
async function precheck(token, chain, env) {
  return { ok: true };
}

// ---------- routes ----------
async function createOrder(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, env, 400); }
  const token = String(body.token || "").trim();
  const chain = String(body.chain || "").trim().toLowerCase();
  const planId = String(body.plan || "");

  if (!/^[A-Za-z0-9]{20,64}$/.test(token)) return json({ error: "invalid token address" }, env, 400);
  if (!/^[a-z0-9_-]{2,20}$/.test(chain)) return json({ error: "invalid chain" }, env, 400);

  const plan = await env.DB.prepare("SELECT * FROM plans WHERE id = ?").bind(planId).first();
  if (!plan) return json({ error: "unknown plan" }, env, 400);

  const check = await precheck(token, chain, env);
  if (!check.ok) return json({ error: check.reason || "token declined" }, env, 422);

  const id = crypto.randomUUID();
  const reference = newReference();
  const created = now();
  await env.DB.prepare(
    "INSERT INTO orders (id, token, chain, plan_id, lamports, reference, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, token, chain, plan.id, plan.lamports, reference, created, created + ORDER_TTL).run();

  return json({
    orderId: id,
    treasury: env.TREASURY,
    lamports: plan.lamports,
    reference: reference, // add as a read-only key on the SOL transfer instruction
    expiresAt: created + ORDER_TTL
  }, env);
}

async function getOrder(id, env) {
  const o = await env.DB.prepare(
    "SELECT id, token, chain, status, paid_signature, expires_at FROM orders WHERE id = ?"
  ).bind(id).first();
  return o ? json(o, env) : json({ error: "not found" }, env, 404);
}

async function featured(env) {
  const t = now();
  const res = await env.DB.prepare(
    "SELECT token, chain, starts_at, expires_at FROM listings WHERE hidden = 0 AND starts_at <= ? AND expires_at > ? ORDER BY starts_at DESC"
  ).bind(t, t).all();
  return json(res.results, env);
}

async function plans(env) {
  const res = await env.DB.prepare("SELECT id, days, lamports FROM plans ORDER BY days").all();
  return json(res.results, env);
}

// ---------- Helius webhook ----------
async function heliusWebhook(request, env) {
  if (!env.HELIUS_WEBHOOK_SECRET ||
      !safeEqual(request.headers.get("Authorization") || "", env.HELIUS_WEBHOOK_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  let txs;
  try { txs = await request.json(); } catch (e) { return new Response("bad json", { status: 400 }); }
  const list = Array.isArray(txs) ? txs : [txs];
  for (const tx of list) {
    await processTx(tx, env);
  }
  return new Response("ok"); // 2xx stops Helius retries
}

async function processTx(tx, env) {
  if (!tx || !tx.signature || tx.transactionError) return;

  // 1. SOL actually received by the treasury in this transaction
  const paid = (tx.nativeTransfers || [])
    .filter((n) => n.toUserAccount === env.TREASURY)
    .reduce((sum, n) => sum + Number(n.amount || 0), 0);
  if (paid <= 0) return;

  // 2. Find the order through the reference key included in the transaction
  const accounts = Array.from(new Set((tx.accountData || []).map((a) => a.account))).slice(0, 64);
  if (!accounts.length) return;
  const qs = accounts.map(() => "?").join(",");
  const order = await env.DB.prepare(
    "SELECT * FROM orders WHERE status = 'pending' AND reference IN (" + qs + ") LIMIT 1"
  ).bind(...accounts).first();
  if (!order) return;

  const t = now();
  const plan = await env.DB.prepare("SELECT days FROM plans WHERE id = ?").bind(order.plan_id).first();

  // 3. Underpaid: record for manual review, do not activate
  if (paid < order.lamports || !plan) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO payments (signature, order_id, lamports, status, created_at) VALUES (?, ?, ?, 'underpaid', ?)"
    ).bind(tx.signature, order.id, paid, t).run();
    return;
  }

  // 4. Activate in one atomic batch. Unique keys make webhook retries harmless.
  //    If the token already has an active listing, the new one starts when it ends.
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO payments (signature, order_id, lamports, status, created_at) VALUES (?1, ?2, ?3, 'confirmed', ?4)"
    ).bind(tx.signature, order.id, paid, t),

    env.DB.prepare(
      "INSERT OR IGNORE INTO listings (order_id, token, chain, payment_signature, starts_at, expires_at) " +
      "SELECT ?1, ?2, ?3, ?4, s, s + ?5 " +
      "FROM (SELECT COALESCE(MAX(expires_at), ?6) AS s FROM listings " +
      "WHERE token = ?2 AND chain = ?3 AND expires_at > ?6 AND hidden = 0)"
    ).bind(order.id, order.token, order.chain, tx.signature, plan.days * 86400, t),

    env.DB.prepare(
      "UPDATE orders SET status = 'paid', paid_signature = ? WHERE id = ?"
    ).bind(tx.signature, order.id)
  ]);
  // TODO: announce on Telegram / X here.
}

// ---------- entry ----------
export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    try {
      if (!env.DB) return json({ error: "D1 binding DB is missing" }, env, 500);
      await ensureSchema(env);

      if (pathname === "/webhook/helius" && request.method === "POST") return await heliusWebhook(request, env);
      if (pathname === "/api/orders" && request.method === "POST") return await createOrder(request, env);
      if (pathname.startsWith("/api/orders/") && request.method === "GET") return await getOrder(pathname.split("/")[3], env);
      if (pathname === "/api/featured" && request.method === "GET") return await featured(env);
      if (pathname === "/api/plans" && request.method === "GET") return await plans(env);
    } catch (err) {
      console.error(err);
      return json({ error: "server error" }, env, 500);
    }
    return json({ error: "not found" }, env, 404);
  },

  // Hourly: drop pending orders that expired more than a day ago.
  async scheduled(event, env) {
    await ensureSchema(env);
    await env.DB.prepare(
      "DELETE FROM orders WHERE status = 'pending' AND expires_at < ?"
    ).bind(now() - 86400).run();
  }
};
