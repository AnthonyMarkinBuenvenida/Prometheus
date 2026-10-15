// Pre-answer failover through POST /api/chat, against one fake server that plays both providers.
// The boundary: a model that fails after streaming only reasoning is replaced (after a "reset"
// event); once answer text has streamed it is never replaced. Stop must end everything.
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
  ROUTER_ATTEMPT_TIMEOUT_SECONDS: "2",
  LOG_REQUESTS: "false",
});
for (const k of ["DATABASE_URL", "OPENROUTER_API_KEY_BACKUP", "OPENROUTER_API_KEY_BACKUP_2"]) delete process.env[k];

/**
 * behaviour(call) →
 *   "ok"            reasoning + answer + finish
 *   "reason-fail"   reasoning, then the provider fails (Gemini: 503 body mid-stream; OpenRouter: error chunk)
 *   "answer-fail"   reasoning + some answer text, then the stream dies
 *   "reason-hang"   reasoning, then nothing (connection stays open)
 *   "hang"          no response at all
 *   { status, json } an HTTP error before streaming
 */
let behaviour = () => "ok";
let calls = [];
let fake;
let app;
let base;
let health;

const gem = (o) => `data: ${JSON.stringify(o)}\r\n\r\n`;
const or = (o) => `data: ${JSON.stringify(o)}\n\n`;
const busy = { error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } };

before(async () => {
  fake = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url.endsWith("/key")) return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: { free_model_daily_requests: { limit: 50, remaining: 50 } } }));
    const isGemini = req.url.includes("streamGenerateContent");
    const json = body ? JSON.parse(body) : {};
    const model = isGemini ? /models\/([^:]+):/.exec(req.url)[1] : json.model;
    const call = { provider: isGemini ? "gemini" : "openrouter", model, n: calls.length, closedEarly: false, ended: false };
    calls.push(call);
    res.on("close", () => {
      if (!call.ended) call.closedEarly = true; // Prometheus cancelled this upstream request
    });
    const end = (s = "") => {
      call.ended = true;
      res.end(s);
    };
    const b = behaviour(call);
    if (b === "hang") return;
    if (typeof b === "object") {
      call.ended = true;
      return res.writeHead(b.status, { "Content-Type": "application/json" }).end(JSON.stringify(b.json));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const thought = `thinking by ${model}`;
    const answer = `answer by ${model}`;
    if (isGemini) {
      res.write(gem({ candidates: [{ content: { role: "model", parts: [{ text: thought, thought: true }] } }] }));
      if (b === "reason-hang") return;
      if (b === "reason-fail") return end(gem(busy) + JSON.stringify(busy, null, 2) + "\n"); // as observed live
      res.write(gem({ candidates: [{ content: { role: "model", parts: [{ text: answer }] } }] }));
      if (b === "answer-fail") return end();
      end(gem({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }));
    } else {
      res.write(or({ choices: [{ delta: { reasoning: thought }, finish_reason: null }] }));
      if (b === "reason-hang") return;
      if (b === "reason-fail") return end(or({ error: { code: 502, message: "Provider returned error" }, choices: [{ delta: {}, finish_reason: "error" }] }));
      res.write(or({ choices: [{ delta: { content: answer }, finish_reason: null }] }));
      if (b === "answer-fail") return end();
      end(or({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
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
  fake.closeAllConnections?.();
  fake.close();
  app.close();
});
beforeEach(() => {
  calls = [];
  behaviour = () => "ok";
  health.resetHealth();
});

const HARD = "Design a distributed rate limiter architecture that is scalable, handles race conditions and edge cases.";
// Failover only happens with "fall back if my chosen model fails" on (there is no automatic selection).
const request = (extra = {}) => ({ model: "gemini-3.8-flash", allowFallback: true, messages: [{ role: "user", content: HARD }], ...extra });

async function chat(body) {
  const r = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.headers.get("content-type")?.includes("event-stream")) return { status: r.status, json: await r.json(), events: [] };
  const events = (await r.text())
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
  return { status: r.status, events };
}

/** Streams a request and aborts it as soon as `stopWhen(event)` is true. */
async function chatAndStop(body, stopWhen) {
  const ctrl = new AbortController();
  const r = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const seen = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!frame.startsWith("data: ")) continue;
        const e = JSON.parse(frame.slice(6));
        seen.push(e);
        if (stopWhen(e)) {
          ctrl.abort();
          return seen;
        }
      }
    }
  } catch {
    // aborted
  }
  return seen;
}

/** What the browser ends up showing: the client discards everything before the last "reset". */
function finalMessage(events) {
  let msg = { model: null, reasoning: "", content: "", error: null };
  for (const e of events) {
    if (e.type === "reset") msg = { model: null, reasoning: "", content: "", error: null };
    else if (e.type === "start") msg.model = e.model;
    else if (e.type === "reasoning") msg.reasoning += e.text;
    else if (e.type === "content") msg.content += e.text;
    else if (e.type === "error") msg.error = e.message;
  }
  return msg;
}

const settle = () => new Promise((r) => setTimeout(r, 1500));

describe("pre-answer failover", () => {
  test("1. a model that fails before any content is replaced silently", async () => {
    behaviour = (c) => (c.n === 0 ? { status: 503, json: busy } : "ok");
    const { events } = await chat(request());
    assert.equal(calls.length, 2);
    assert.equal(events.filter((e) => e.type === "start").length, 1, "nothing reached the browser from the failed attempt");
    assert.equal(events.some((e) => e.type === "reset"), false);
    assert.equal(finalMessage(events).content, `answer by ${calls[1].model}`);
  });

  test("2. a model that fails after streaming only reasoning is replaced (reset, then a fresh start)", async () => {
    behaviour = (c) => (c.n === 0 ? "reason-fail" : "ok");
    const { events } = await chat(request());
    assert.equal(calls.length, 2);
    assert.notEqual(calls[1].model, calls[0].model, "never the same model twice");
    assert.deepEqual(events.map((e) => e.type), ["start", "reasoning", "reset", "start", "reasoning", "content", "done"]);
    const reset = events.find((e) => e.type === "reset");
    assert.match(reset.message, /busy\. Trying another available model/);
    const second = events.filter((e) => e.type === "start")[1];
    assert.equal(second.model, calls[1].model);
    assert.deepEqual(second.route.fallbackFrom.length, 1);
  });

  test("2b. the same works when OpenRouter fails during reasoning", async () => {
    behaviour = (c) => (c.n === 0 ? "reason-fail" : "ok");
    const { events } = await chat(request({ model: "qwen/qwen3.8-27b:free", allowFallback: true }));
    assert.equal(calls[0].provider, "openrouter");
    assert.ok(events.some((e) => e.type === "reset"));
    assert.equal(finalMessage(events).content, `answer by ${calls[1].model}`);
  });

  test("3. once answer text has streamed, the model is never replaced", async () => {
    behaviour = () => "answer-fail";
    const { events } = await chat(request());
    assert.equal(calls.length, 1);
    assert.equal(events.some((e) => e.type === "reset"), false);
    assert.equal(events.at(-1).type, "error");
    assert.equal(finalMessage(events).content, `answer by ${calls[0].model}`, "the partial answer is kept, not mixed");
  });

  test("4. the final message holds only the second model's reasoning and answer", async () => {
    behaviour = (c) => (c.n === 0 ? "reason-fail" : "ok");
    const { events } = await chat(request());
    const shown = finalMessage(events);
    const [a, b] = calls.map((c) => c.model);
    assert.equal(shown.model, b);
    assert.equal(shown.reasoning, `thinking by ${b}`);
    assert.equal(shown.content, `answer by ${b}`);
    assert.doesNotMatch(JSON.stringify(shown), new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test("5. Stop during the first model's reasoning: no other model is started", async () => {
    behaviour = () => "reason-hang";
    const seen = await chatAndStop(request(), (e) => e.type === "reasoning");
    assert.ok(seen.some((e) => e.type === "reasoning"));
    await settle();
    assert.equal(calls.length, 1, "no second model");
    assert.equal(calls[0].closedEarly, true, "the upstream request was cancelled");
  });

  test("6. Stop during the switch to the next model: that generation is cancelled too", async () => {
    behaviour = (c) => (c.n === 0 ? "reason-fail" : "reason-hang");
    const seen = await chatAndStop(request(), (e) => e.type === "start" && seen2(e));
    function seen2() {
      return calls.length === 2; // the replacement model's stream has started
    }
    assert.ok(seen.some((e) => e.type === "reset"));
    await settle();
    assert.equal(calls.length, 2, "no third model");
    assert.equal(calls[1].closedEarly, true, "the replacement model's request was cancelled");
  });

  test("6b. Stop right after the reset, before the next model answers: it is cancelled and nothing follows", async () => {
    behaviour = (c) => (c.n === 0 ? "reason-fail" : "hang");
    const seen = await chatAndStop(request(), (e) => e.type === "reset");
    assert.ok(seen.some((e) => e.type === "reset"));
    await settle();
    assert.ok(calls.length <= 2, `calls: ${calls.length}`);
    if (calls.length === 2) assert.equal(calls[1].closedEarly, true, "the pending request was cancelled");
  });

  test("7. manual model, fallback off: a reasoning-only failure is an error, not a switch", async () => {
    behaviour = () => "reason-fail";
    const { events } = await chat(request({ model: "gemini-3.8-flash", allowFallback: false }));
    assert.equal(calls.length, 1);
    assert.equal(events.some((e) => e.type === "reset"), false);
    assert.equal(events.at(-1).type, "error");
    assert.equal(finalMessage(events).model, "gemini-3.8-flash");
  });

  test("8. manual model, fallback on: the reasoning-only failure falls back", async () => {
    behaviour = (c) => (c.model === "gemini-3.8-flash" ? "reason-fail" : "ok");
    const { events } = await chat(request({ model: "gemini-3.8-flash", allowFallback: true }));
    assert.ok(events.some((e) => e.type === "reset"));
    const second = events.filter((e) => e.type === "start")[1];
    assert.notEqual(second.model, "gemini-3.8-flash");
    assert.match(second.route.reason, /Your chosen model \(Gemini 3\.8 Flash\) was unavailable/);
    assert.equal(finalMessage(events).content, `answer by ${second.model}`);
  });

  test("9. at most ROUTER_MAX_ATTEMPTS models, even when each fails after reasoning", async () => {
    behaviour = () => "reason-fail";
    const { events } = await chat(request());
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((c) => c.model)).size, 3);
    assert.equal(events.filter((e) => e.type === "reset").length, 2, "a reset only before each replacement");
    assert.equal(events.at(-1).type, "error");
    assert.equal(finalMessage(events).reasoning, `thinking by ${calls[2].model}`, "only the last model's reasoning remains");
  });

  test("10. when every fallback fails, a clear error and no leftover content", async () => {
    behaviour = (c) => (c.n === 1 ? { status: 503, json: busy } : "reason-fail");
    const { events } = await chat(request());
    const shown = finalMessage(events);
    assert.equal(shown.content, "");
    assert.equal(shown.model, calls[2].model);
    assert.equal(shown.reasoning, `thinking by ${calls[2].model}`, "no reasoning from earlier models");
    assert.match(shown.error, /No available model could answer right now \(tried .+, .+, .+\)/);
  });

  test("health: the model that failed during reasoning cools down and isn't used as a fallback", async () => {
    behaviour = (c) => (c.n === 0 ? "reason-fail" : "ok");
    await chat(request());
    const failed = calls[0].model;
    const status = (await (await fetch(base + "/api/models")).json()).models.find((m) => m.id === failed).status;
    assert.equal(status, "cooling");
    // Another chosen model fails next: the cooling model is not picked as its fallback.
    calls = [];
    behaviour = (c) => (c.n === 0 ? { status: 503, json: busy } : "ok");
    await chat(request({ model: "gemini-3.7-flash" }));
    assert.notEqual(calls[1].model, failed);
  });
});
