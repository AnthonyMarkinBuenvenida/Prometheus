// Model selection and opt-in fallback end to end through POST /api/chat, against one fake server that plays both Gemini and
// OpenRouter: provider/model failures, timeouts, rate limits, quota exhaustion, failures before and
// after the first token, default and manual model, max attempts, debug output.
// Run: npm test
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

Object.assign(process.env, {
  MODEL_REGISTRY_LIVE: "false",
  GEMINI_API_KEY: "gemini-test-not-real",
  OPENROUTER_API_KEY: "sk-or-test-not-real",
  RATE_LIMIT_CHAT_PER_MIN: "1000",
  RATE_LIMIT_CHAT_PER_DAY: "1000",
  MAX_CONCURRENT_STREAMS: "50",
  ROUTER_ATTEMPT_TIMEOUT_SECONDS: "1",
  LOG_REQUESTS: "false",
});
delete process.env.DATABASE_URL;
delete process.env.OPENROUTER_API_KEY_BACKUP;
delete process.env.OPENROUTER_API_KEY_BACKUP_2;

/** behaviour(call) → "ok" | "hang" | "empty" | "break-after-text" | { status, json } */
let behaviour = () => "ok";
let calls = [];
let fake;
let app;
let base;
let health;

const geminiChunk = (o) => `data: ${JSON.stringify(o)}\r\n\r\n`;
const orChunk = (o) => `data: ${JSON.stringify(o)}\n\n`;

before(async () => {
  fake = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url.endsWith("/key")) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: { free_model_daily_requests: { limit: 50, remaining: 50 } } }));
    const isGemini = req.url.includes("streamGenerateContent");
    const json = body ? JSON.parse(body) : {};
    const model = isGemini ? /models\/([^:]+):/.exec(req.url)[1] : json.model;
    const call = { provider: isGemini ? "gemini" : "openrouter", model, body: json, n: calls.length };
    calls.push(call);
    const b = behaviour(call);
    if (b === "hang") return; // never answers: the attempt timeout must fire
    if (typeof b === "object") return res.writeHead(b.status, { "Content-Type": "application/json" }).end(JSON.stringify(b.json));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const text = `ok from ${model}`;
    if (isGemini) {
      if (b === "empty") return res.end(); // stream ends with no finish reason
      res.write(geminiChunk({ candidates: [{ content: { role: "model", parts: [{ text }] } }] }));
      if (b === "break-after-text") return res.end();
      res.end(geminiChunk({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }));
    } else {
      if (b === "empty") return res.end();
      res.write(orChunk({ choices: [{ delta: { content: text }, finish_reason: null }] }));
      if (b === "break-after-text") return res.end();
      res.end(orChunk({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
    }
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const port = fake.address().port;
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}/api/v1`;
  const { handleApi } = await import("./api.mjs");
  health = await import("./router/health.mjs");
  app = createServer((req, res) => handleApi(req, res).then((h) => !h && res.writeHead(404).end()));
  await new Promise((r) => app.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => {
  fake.close();
  app.close();
});
beforeEach(() => {
  calls = [];
  behaviour = () => "ok";
  health.resetHealth();
});

async function chat(body) {
  const r = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], debug: true, ...body }) });
  if (!r.headers.get("content-type")?.includes("event-stream")) return { status: r.status, json: await r.json() };
  const events = (await r.text())
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
  return { status: r.status, events, start: events[0], text: events.filter((e) => e.type === "content").map((e) => e.text).join("") };
}

const HARD = "Design a distributed rate limiter architecture that is scalable, handles race conditions and edge cases.";
// Fallback is only ever opt-in now: a chosen model with "fall back if my chosen model fails" on.
const FB = { model: "gemini-3.8-flash", allowFallback: true };
const busy503 = { status: 503, json: { error: { code: 503, message: "high demand", status: "UNAVAILABLE" } } };

describe("default model (no automatic selection)", () => {
  test("the default is a real model, Gemini 3.6 Flash — never 'auto'", async () => {
    const models = await (await fetch(base + "/api/models")).json();
    assert.equal(models.defaultModel, "gemini-3.6-flash");
    assert.ok(models.models.every((m) => m.id !== "auto"));
  });

  test("a request without a model uses the default model", async () => {
    const r = await chat({});
    assert.equal(r.status, 200);
    assert.equal(r.start.model, "gemini-3.6-flash");
    assert.equal(r.start.route.mode, "manual");
    assert.deepEqual(calls.map((c) => c.model), ["gemini-3.6-flash"]);
  });

  test("'auto' from a page loaded before the change also means the default model", async () => {
    const r = await chat({ model: "auto" });
    assert.equal(r.start.model, "gemini-3.6-flash");
    assert.equal(calls.length, 1);
  });

  test("the model doesn't change with the task", async () => {
    const simple = await chat({});
    const hard = await chat({ messages: [{ role: "user", content: HARD }] });
    assert.equal(simple.start.model, hard.start.model);
  });

  test("DEFAULT_MODEL sets the default when it names an available model", async () => {
    const saved = process.env.DEFAULT_MODEL;
    process.env.DEFAULT_MODEL = "gemini-3.5-flash-lite";
    assert.equal((await (await fetch(base + "/api/models")).json()).defaultModel, "gemini-3.5-flash-lite");
    process.env.DEFAULT_MODEL = "nvidia/some-removed-model"; // stale value → preferred default
    assert.equal((await (await fetch(base + "/api/models")).json()).defaultModel, "gemini-3.6-flash");
    if (saved === undefined) delete process.env.DEFAULT_MODEL;
    else process.env.DEFAULT_MODEL = saved;
  });

  test("debug details: classification, candidates, attempts — and no secrets or message text", async () => {
    const r = await chat({ ...FB, messages: [{ role: "user", content: "secret-phrase-123 what is 2+2?" }] });
    const d = r.start.debug;
    assert.ok(d.task.type && d.candidates.length && d.attempts.length === 1 && d.fallbacksAvailable.length);
    assert.doesNotMatch(JSON.stringify(r.start), /not-real|secret-phrase-123/);
  });

  test("without debug, only the short route summary is sent", async () => {
    const r = await chat({ debug: false });
    assert.equal(r.start.debug, undefined);
    assert.deepEqual(Object.keys(r.start.route).sort(), ["fallbackFrom", "mode", "model", "provider", "reason", "task"]);
  });
});

describe("fallback (opt-in)", () => {
  test("model unavailable (404) → next model; health records it", async () => {
    behaviour = (c) => (c.n === 0 ? { status: 404, json: { error: { code: 404, message: "not found" } } } : "ok");
    const r = await chat(FB);
    assert.equal(r.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].model, "gemini-3.8-flash");
    assert.notEqual(calls[1].model, calls[0].model);
    assert.equal(r.start.model, calls[1].model);
    assert.equal(r.start.route.fallbackFrom.length, 1);
    const models = await (await fetch(base + "/api/models")).json();
    assert.equal(models.models.find((m) => m.id === calls[0].model).status, "cooling");
  });

  test("Gemini outage (503 on every Gemini model) → OpenRouter answers", async () => {
    behaviour = (c) => (c.provider === "gemini" ? busy503 : "ok");
    const r = await chat({ ...FB, messages: [{ role: "user", content: HARD }] });
    assert.equal(r.status, 200);
    assert.equal(r.start.route.provider, "OpenRouter");
  });

  test("provider coverage: every earlier attempt failed on Gemini → the last attempt goes to OpenRouter", async () => {
    behaviour = (c) => (c.provider === "gemini" ? busy503 : "ok");
    const r = await chat({ ...FB, messages: [{ role: "user", content: HARD }] });
    assert.equal(r.status, 200);
    assert.deepEqual(calls.map((c) => c.provider), ["gemini", "gemini", "openrouter"]);
    const rest = r.start.debug.candidates.map((c) => c.model).filter((id) => id !== FB.model);
    assert.ok(rest.slice(0, 2).every((id) => !id.includes("/")), "the next two by ranking are Gemini, so the rule (not the ranking) chose OpenRouter");
  });

  test("provider coverage: when the chosen model works, nothing else is tried", async () => {
    await chat({ ...FB, messages: [{ role: "user", content: HARD }] });
    assert.deepEqual(calls.map((c) => c.model), [FB.model]);
  });

  test("provider coverage: a failure before the last attempt doesn't force a provider switch", async () => {
    behaviour = (c) => (c.n === 0 ? busy503 : "ok");
    const r = await chat({ ...FB, messages: [{ role: "user", content: HARD }] });
    assert.equal(calls.length, 2);
    const rest = r.start.debug.candidates.map((c) => c.model).filter((id) => id !== FB.model);
    assert.equal(calls[1].model, rest[0], "second attempt = best-ranked remaining model, same provider allowed");
  });

  test("OpenRouter outage → Gemini answers", async () => {
    behaviour = (c) => (c.provider === "openrouter" ? { status: 502, json: { error: { code: 502, message: "Provider returned error" } } } : "ok");
    const r = await chat({ model: "qwen/qwen3.8-27b:free", allowFallback: true });
    assert.equal(r.status, 200);
    assert.equal(calls[0].provider, "openrouter");
    assert.equal(calls.at(-1).provider, "gemini");
  });

  test("timeout (model never starts) → next model within the attempt timeout", async () => {
    behaviour = (c) => (c.n === 0 ? "hang" : "ok");
    const t0 = Date.now();
    const r = await chat(FB);
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 < 5_000);
    assert.equal(r.start.debug.attempts[0].error, "upstream_timeout");
  });

  test("rate limit (429) → another model", async () => {
    behaviour = (c) => (c.n === 0 ? { status: 429, json: { error: { code: 429, message: "Resource exhausted" } } } : "ok");
    const r = await chat(FB);
    assert.equal(r.status, 200);
    assert.equal(r.start.debug.attempts[0].error, "rate_limited");
  });

  test("OpenRouter's daily free quota → no other free OpenRouter model is tried in that request", async () => {
    behaviour = (c) =>
      c.provider === "openrouter" ? { status: 429, json: { error: { code: 429, message: "Rate limit exceeded: free-models-per-day." } } } : { status: 503, json: { error: { code: 503, message: "busy" } } };
    await chat({ model: "qwen/qwen3.8-27b:free", allowFallback: true, messages: [{ role: "user", content: HARD }] });
    const freeOr = calls.filter((c) => c.provider === "openrouter" && c.model.endsWith(":free"));
    assert.ok(freeOr.length <= 1, `tried ${freeOr.length} free OpenRouter models`);
  });

  test("a stream that dies before the first token falls back; nothing reaches the browser twice", async () => {
    behaviour = (c) => (c.n === 0 ? "empty" : "ok");
    const r = await chat(FB);
    assert.equal(r.events.filter((e) => e.type === "start").length, 1);
    assert.equal(r.text, `ok from ${calls[1].model}`);
  });

  test("a failure after text has streamed is reported, not switched (no corrupted answer)", async () => {
    behaviour = () => "break-after-text";
    const r = await chat(FB);
    assert.equal(calls.length, 1);
    assert.equal(r.text, `ok from ${calls[0].model}`);
    assert.equal(r.events.at(-1).type, "error");
  });

  test("at most ROUTER_MAX_ATTEMPTS models, then a clear explanation", async () => {
    behaviour = () => busy503;
    const r = await chat(FB);
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((c) => c.model)).size, 3, "never the same model twice");
    assert.match(r.json.error.message, /No available model could answer right now \(tried .+, .+, .+\)/);
  });

  test("recovery: a failed model cools down, then reports ok again", async () => {
    let t = Date.now();
    health.resetHealth(() => t);
    behaviour = (c) => (c.n === 0 ? busy503 : "ok");
    await chat(FB);
    const status = async () => (await (await fetch(base + "/api/models")).json()).models.find((m) => m.id === FB.model).status;
    assert.equal(await status(), "cooling");
    t += 16 * 60_000; // cooldown over and the failure has left the 15-minute window
    assert.equal(await status(), "ok");
  });
});

describe("manual mode", () => {
  test("the chosen model is used", async () => {
    const r = await chat({ model: "nvidia/nemotron-3-super-120b-a12b:free" });
    assert.equal(r.start.model, "nvidia/nemotron-3-super-120b-a12b:free");
    assert.equal(r.start.route.mode, "manual");
  });

  test("a failing chosen model is not silently replaced (fallback is off by default)", async () => {
    behaviour = () => busy503;
    const r = await chat({ model: "gemini-3.8-flash" });
    assert.equal(calls.length, 1);
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, "upstream_busy");
  });

  test("…unless the user enabled fallback", async () => {
    behaviour = (c) => (c.model === "gemini-3.8-flash" ? busy503 : "ok");
    const r = await chat(FB);
    assert.equal(r.status, 200);
    assert.notEqual(r.start.model, "gemini-3.8-flash");
    assert.deepEqual(r.start.route.fallbackFrom, ["Gemini 3.8 Flash"]);
    assert.match(r.start.route.reason, /Your chosen model \(Gemini 3\.8 Flash\) was unavailable/);
  });

  test("an unknown model id is refused clearly", async () => {
    const r = await chat({ model: "some/removed-model" });
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /no longer available/);
  });
});

describe("stop", () => {
  test("Stop during the first attempt ends cleanly; the next request works", async () => {
    behaviour = (c) => (c.n === 0 ? "hang" : "ok");
    const ctrl = new AbortController();
    const p = fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...FB, messages: [{ role: "user", content: "hi" }] }), signal: ctrl.signal }).catch((e) => e.name);
    setTimeout(() => ctrl.abort(), 200);
    assert.equal(await p, "AbortError");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(calls.length, 1, "no fallback after the user stopped");
    calls = [];
    behaviour = () => "ok";
    assert.equal((await chat({})).status, 200);
  });
});
