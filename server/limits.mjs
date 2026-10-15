// Rate limiting for the public demo. Anyone with the URL can use the Gemini-backed API, so
// these limits are the abuse protection.
//
// Storage:
//   DATABASE_URL / POSTGRES_URL set → Postgres (Neon over HTTP): limits are GLOBAL across every
//                                      Vercel instance and survive restarts.
//   otherwise                      → process memory: limits apply PER INSTANCE only (local dev,
//                                      or a degraded fallback if the database errors).
//
// Counters use fixed windows (count + expiry per key). Each concurrency slot is its own row
// holding a short lease (SLOT_LEASE_MS) that the stream renews while it runs. On Vercel a
// cancelled or frozen function never gets to release its slot (verified in production), so the
// lease is what frees it: within SLOT_LEASE_MS, not after the whole stream limit.

export const SLOT_LEASE_MS = 30_000;
const SLOT_RENEW_MS = 10_000;

import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";

function intEnv(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function limitSettings() {
  return {
    perMinute: intEnv("RATE_LIMIT_CHAT_PER_MIN", 6),
    perDay: intEnv("RATE_LIMIT_CHAT_PER_DAY", 120),
    globalPerDay: intEnv("RATE_LIMIT_GLOBAL_PER_DAY", 1500),
    concurrent: intEnv("MAX_CONCURRENT_STREAMS", 2),
  };
}

// ---------- Stores ----------

/** In-process store. Exported for tests. */
export function createMemoryStore(now = () => Date.now()) {
  const windows = new Map(); // key -> { count, resetAt }
  const slots = new Map(); // key -> count
  return {
    kind: "memory",
    async hit(keys) {
      const t = now();
      return keys.map(({ key, windowMs }) => {
        let w = windows.get(key);
        if (!w || w.resetAt <= t) w = { count: 0, resetAt: t + windowMs };
        w.count++;
        windows.set(key, w);
        return { count: w.count, resetAt: w.resetAt };
      });
    },
    /** Returns a slot id, or null when `key` already holds `limit` slots. */
    async acquire(key, limit) {
      const n = (slots.get(key) ?? 0) + 1;
      if (n > limit) return null;
      slots.set(key, n);
      return key;
    },
    async release(slotId) {
      const n = (slots.get(slotId) ?? 1) - 1;
      if (n <= 0) slots.delete(slotId);
      else slots.set(slotId, n);
    },
    async renew() {},
    prune() {
      const t = now();
      for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
    },
  };
}

const UPSERT = `
INSERT INTO prometheus_limits AS l (key, count, expires_at)
VALUES ($1, 1, now() + make_interval(secs => $2::double precision / 1000))
ON CONFLICT (key) DO UPDATE SET
  count = CASE WHEN l.expires_at <= now() THEN 1 ELSE l.count + 1 END,
  expires_at = CASE WHEN l.expires_at <= now() THEN now() + make_interval(secs => $2::double precision / 1000) ELSE l.expires_at END
RETURNING count, (extract(epoch FROM expires_at) * 1000)::bigint AS reset_at`;

/** Postgres store (Neon serverless driver, one HTTP round trip per operation). */
export function createPostgresStore(url) {
  const sql = neon(url);
  let ready = null;
  const ensureTable = () =>
    (ready ??= sql
      .query("CREATE TABLE IF NOT EXISTS prometheus_limits (key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL)")
      .catch((err) => {
        ready = null; // retry on the next request
        throw err;
      }));

  return {
    kind: "postgres",
    async hit(keys) {
      await ensureTable();
      const rows = await sql.transaction(keys.map(({ key, windowMs }) => sql.query(UPSERT, [key, windowMs])));
      // Occasionally sweep long-expired rows so the table stays small.
      if (Math.random() < 0.02) sql.query("DELETE FROM prometheus_limits WHERE expires_at < now() - interval '1 day'").catch(() => {});
      return rows.map(([r]) => ({ count: Number(r.count), resetAt: Number(r.reset_at) }));
    },
    /** One row per slot (`<key>/<uuid>`); live slots are rows that haven't expired. */
    async acquire(key, limit, ttlMs) {
      await ensureTable();
      const slotId = `${key}/${randomUUID()}`;
      const prefix = `${key.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`;
      const [, [r]] = await sql.transaction([
        sql.query("INSERT INTO prometheus_limits (key, count, expires_at) VALUES ($1, 1, now() + make_interval(secs => $2::double precision / 1000))", [slotId, ttlMs]),
        sql.query("SELECT count(*)::int AS n FROM prometheus_limits WHERE key LIKE $1 AND expires_at > now()", [prefix]),
      ]);
      if (r.n > limit) {
        await this.release(slotId);
        return null;
      }
      return slotId;
    },
    async release(slotId) {
      await sql.query("DELETE FROM prometheus_limits WHERE key = $1", [slotId]);
    },
    async renew(slotId, ttlMs) {
      await sql.query("UPDATE prometheus_limits SET expires_at = now() + make_interval(secs => $2::double precision / 1000) WHERE key = $1", [slotId, ttlMs]);
    },
  };
}

// ---------- Limiter ----------

const memory = createMemoryStore();
setInterval(() => memory.prune(), 300_000).unref?.();
let primary;

function primaryStore() {
  if (primary !== undefined) return primary;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  primary = url ? createPostgresStore(url) : memory;
  return primary;
}

/** Which store enforces limits right now (for logs/health; never includes connection details). */
export function limitScope() {
  return primaryStore().kind === "postgres" ? "global" : "per-instance";
}

/** Runs `fn` on the primary store; on a database failure, logs (no secrets) and uses memory. */
async function withStore(fn) {
  const store = primaryStore();
  try {
    return await fn(store);
  } catch (err) {
    // A limit decision is final; only infrastructure failures fall back to memory.
    if (store === memory || err instanceof LimitError) throw err;
    console.error(`[limits] database unavailable, using per-instance memory: ${err?.code ?? err?.name ?? "error"}`);
    return fn(memory);
  }
}

export class LimitError extends Error {
  constructor(message, code, retryAfterMs) {
    super(message);
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function wait(ms) {
  return ms < 120_000 ? `${Math.ceil(ms / 1000)} seconds` : ms < 7_200_000 ? `${Math.ceil(ms / 60_000)} minutes` : `${Math.ceil(ms / 3_600_000)} hours`;
}

/**
 * Counts one chat request for this client and reserves a generation slot.
 * Resolves to a release() function; rejects with LimitError when a limit is exceeded.
 */
export async function acquireChat(ip, { leaseMs = SLOT_LEASE_MS, renewMs = SLOT_RENEW_MS } = {}) {
  const s = limitSettings();
  const day = 86_400_000;
  const windows = [
    { key: `m:${ip}`, windowMs: 60_000, limit: s.perMinute, message: "You've reached the per-minute message limit for this demo." },
    { key: `d:${ip}`, windowMs: day, limit: s.perDay, message: "You've reached today's message limit for this demo." },
    { key: "g:day", windowMs: day, limit: s.globalPerDay, message: "The demo has reached its total message limit for today." },
  ];

  return withStore(async (store) => {
    const now = Date.now();
    const results = await store.hit(windows);
    for (let i = 0; i < windows.length; i++) {
      if (results[i].count > windows[i].limit) {
        const retry = Math.max(1000, results[i].resetAt - now);
        throw new LimitError(`${windows[i].message} Try again in ${wait(retry)}.`, "rate_limited", retry);
      }
    }
    const slotId = await store.acquire(`slot:${ip}`, s.concurrent, leaseMs);
    if (!slotId) {
      throw new LimitError(`Only ${s.concurrent} responses can generate at once. Wait for one to finish.`, "too_many_streams", 5000);
    }
    // Keep the lease alive while this request runs; if the function is cancelled or frozen the
    // renewals stop and the slot expires on its own.
    const heartbeat = setInterval(() => {
      store.renew(slotId, leaseMs).catch(() => {});
    }, renewMs);
    heartbeat.unref?.();
    // Awaited before the response ends on the normal path (work after it may never run on Vercel).
    let released = null;
    return () => {
      clearInterval(heartbeat);
      return (released ??= store.release(slotId).catch((err) => console.error(`[limits] release failed: ${err?.code ?? err?.name ?? "error"}`)));
    };
  });
}
