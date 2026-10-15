// Server tests for the public demo: access, abuse limits, request limits, token planning and
// Vercel config. No Gemini calls (the upstream URL is unreachable on purpose; streaming against a
// fake Gemini server is tested in gemini.test.mjs).
// Run: npm test   (the Postgres store test runs only when DATABASE_URL/POSTGRES_URL is set)
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createMemoryStore, createPostgresStore } from "./limits.mjs";
import { modelOutputLimit, parseLimitFromError, planMaxTokens } from "./tokens.mjs";
import { SNAPSHOT as MODELS } from "./catalog-snapshot.mjs";
import { SECURITY_HEADERS } from "./securityHeaders.mjs";

Object.assign(process.env, {
  GEMINI_API_KEY: "test-key-not-real",
  GEMINI_BASE_URL: "http://127.0.0.1:1", // unreachable: chat must fail safely
  RATE_LIMIT_CHAT_PER_MIN: "3",
  LOG_REQUESTS: "false",
  MODEL_REGISTRY_LIVE: "false", // registry from the snapshot: no network
});
delete process.env.DATABASE_URL; // the router tests use the in-memory store
const dbUrl = process.env.POSTGRES_URL_FOR_TESTS;

// ---------- Stores ----------
describe("memory store", () => {
  test("fixed window counts up and resets after the window", async () => {
    let now = 0;
    const s = createMemoryStore(() => now);
    const w = [{ key: "k", windowMs: 1000 }];
    assert.equal((await s.hit(w))[0].count, 1);
    assert.equal((await s.hit(w))[0].count, 2);
    assert.equal((await s.hit(w))[0].resetAt, 1000);
    now = 1000;
    assert.equal((await s.hit(w))[0].count, 1);
  });
  test("concurrency slots acquire up to the limit and release", async () => {
    const s = createMemoryStore();
    const id = await s.acquire("c", 1);
    assert.ok(id);
    assert.equal(await s.acquire("c", 1), null);
    await s.release(id);
    assert.ok(await s.acquire("c", 1));
  });
});

describe("postgres store", { skip: !dbUrl && "set POSTGRES_URL_FOR_TESTS to run against a real database" }, () => {
  test("window counts and slots are shared through the database", async () => {
    const a = createPostgresStore(dbUrl);
    const b = createPostgresStore(dbUrl); // a second "instance"
    const key = `test:${Date.now()}:${Math.random()}`;
    const w = [{ key, windowMs: 60_000 }];
    assert.equal((await a.hit(w))[0].count, 1);
    assert.equal((await b.hit(w))[0].count, 2, "second instance sees the first one's hit");
    const slot = await a.acquire(`${key}:slot`, 1, 60_000);
    assert.ok(slot);
    assert.equal(await b.acquire(`${key}:slot`, 1, 60_000), null, "slot limit is global");
    await a.release(slot);
    const again = await b.acquire(`${key}:slot`, 1, 60_000);
    assert.ok(again);
    await b.release(again);
  });

  test("renewing a lease keeps the slot; a leaked slot (never released) expires on its own", async () => {
    const s = createPostgresStore(dbUrl);
    const key = `test:leak:${Date.now()}:${Math.random()}`;
    const held = await s.acquire(key, 1, 1500);
    assert.ok(held);
    await new Promise((r) => setTimeout(r, 1000));
    await s.renew(held, 1500); // a live stream's heartbeat
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await s.acquire(key, 1, 1500), null, "renewed lease still holds the slot");
    // simulate a function killed before release: no more renewals
    await new Promise((r) => setTimeout(r, 2000));
    const fresh = await s.acquire(key, 1, 1500);
    assert.ok(fresh, "expired slot no longer counts");
    await s.release(fresh);
  });
});

// ---------- Token planning ----------
describe("output tokens", () => {
  const flash = MODELS[0];
  const small = { maxOutput: 65_536, contextWindow: 131_072 };

  test("each model offers min(300K app cap, its own maximum)", () => {
    for (const m of MODELS) assert.equal(modelOutputLimit(m), Math.min(300_000, m.maxOutput), m.id);
  });
  test("falls back to the model maximum when it is below the cap", () => {
    assert.equal(modelOutputLimit({ maxOutput: 8192 }), 8192);
    assert.equal(planMaxTokens({ maxOutput: 8192, contextWindow: null }, 50_000, 100), 8192);
  });
  test("request is clamped to the cap and to the context left after the prompt", () => {
    assert.equal(planMaxTokens(flash, 999_999, 100), Math.min(300_000, flash.maxOutput));
    assert.equal(planMaxTokens(flash, 10, 100), 256);
    // 300k chars ≈ 100k tokens of prompt: only ~30.8k remain in a 131,072 context
    const n = planMaxTokens(small, 50_000, 300_000);
    assert.ok(n < 50_000 && n > 25_000, `got ${n}`);
  });
  test("the real ceiling is read from Gemini validation errors", () => {
    assert.equal(
      parseLimitFromError("Unable to submit request because it has a maxOutputTokens value of 50000 but the supported range is from 1 (inclusive) to 32769 (exclusive). Update the value and try again.", 50_000),
      32_768,
    );
    assert.equal(parseLimitFromError("maxOutputTokens must not exceed 8192", 50_000), 8192);
    assert.equal(parseLimitFromError("some unrelated 400", 50_000), null);
  });
});

// ---------- Router (public access) ----------
describe("API router (public demo)", () => {
  let base;
  let server;
  before(async () => {
    const { handleApi } = await import("./api.mjs");
    server = createServer((req, res) => handleApi(req, res).then((h) => !h && res.writeHead(404).end()));
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const post = (path, body, headers = {}) =>
    fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const chatBody = { model: MODELS[0].id, messages: [{ role: "user", content: "hi" }] };

  test("routes are public: no sign-in, no cookies", async () => {
    const r = await fetch(base + "/api/models");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null);
    const body = await r.json();
    // Only GEMINI_API_KEY is set here: OpenRouter models are hidden until OPENROUTER_API_KEY is.
    assert.deepEqual(body.models.map((m) => m.id).sort(), MODELS.filter((m) => m.provider === "gemini").map((m) => m.id).sort());
    assert.equal(body.defaultModel, "gemini-3.6-flash"); // a real model: there is no automatic selection
    assert.ok(body.models.every((m) => m.provider === "Gemini API"));
    assert.deepEqual(body.limits.outputCap, 300_000);
    assert.equal(body.limits.rateLimitScope, "per-instance");
    for (const m of body.models) assert.ok(m.maxOutput <= 300_000);
  });

  test("no authentication routes exist", async () => {
    for (const path of ["/api/auth/login", "/api/auth/logout", "/api/auth/session"]) {
      const r = await post(path, {});
      assert.equal(r.status, 404, path);
    }
  });

  test("cross-origin POST is refused", async () => {
    assert.equal((await post("/api/chat", chatBody, { Origin: "https://evil.example" })).status, 403);
  });

  test("non-JSON and oversized bodies are refused", async () => {
    const text = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hi" });
    assert.equal(text.status, 415);
    const big = await post("/api/chat", { ...chatBody, messages: [{ role: "user", content: "x".repeat(2_100_000) }] });
    assert.equal(big.status, 413);
  });

  test("upstream failure is reported safely, then the per-minute limit applies", async () => {
    // Limits apply before the body is read, so the 415 and 413 above already used 2 of the 3
    // per-minute requests for this IP: this is the 3rd, the next one is refused.
    const first = await post("/api/chat", chatBody);
    assert.equal(first.status, 502);
    const err = (await first.json()).error;
    assert.equal(err.code, "upstream_unreachable");
    assert.doesNotMatch(JSON.stringify(err), /test-key-not-real|stack|at /);
    const limited = await post("/api/chat", chatBody);
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
  });

  test("unknown route 404, wrong method 405", async () => {
    assert.equal((await fetch(base + "/api/nope")).status, 404);
    assert.equal((await fetch(base + "/api/chat")).status, 405);
  });
});

// ---------- Vercel config ----------
describe("vercel.json", () => {
  const cfg = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

  test("security headers match server/securityHeaders.mjs", () => {
    const all = cfg.headers.find((h) => h.source === "/(.*)");
    assert.deepEqual(Object.fromEntries(all.headers.map((h) => [h.key, h.value])), SECURITY_HEADERS);
  });

  test("chat function duration matches the server's stream limit", async () => {
    const { streamLimitMs } = await import("./api.mjs");
    const saved = process.env.VERCEL;
    process.env.VERCEL = "1";
    const max = cfg.functions["api/chat.mjs"].maxDuration;
    assert.equal(streamLimitMs(), (Number(process.env.FUNCTION_MAX_DURATION) || max) * 1000 - 15_000);
    assert.equal(max, 300, "update FUNCTION_MAX_DURATION docs if this changes");
    if (saved === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved;
  });

  test("career function streams under the same limits as chat", () => {
    assert.deepEqual(cfg.functions["api/career.mjs"], cfg.functions["api/chat.mjs"]);
  });

  test("every API route has a function file", () => {
    for (const fn of Object.keys(cfg.functions)) readFileSync(new URL(`../${fn}`, import.meta.url));
  });
});
