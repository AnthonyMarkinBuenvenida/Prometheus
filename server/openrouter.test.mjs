// Streaming against a fake OpenRouter API (no network, no real key): request mapping, reasoning
// on/off, keep-alive comments, mid-stream errors, error mapping, health, and two providers together.
// Run: npm test
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

Object.assign(process.env, { MODEL_REGISTRY_LIVE: "false", OPENROUTER_API_KEY: "sk-or-test-not-real", GEMINI_API_KEY: "gemini-test-not-real", RATE_LIMIT_CHAT_PER_MIN: "1000", LOG_REQUESTS: "false" });
delete process.env.DATABASE_URL;

/** Fake upstream. `reply(call)` returns { status, json } or { lines: [string, …] } (raw SSE lines). */
let reply = () => ({ lines: [] });
let calls = [];
let fake;
let app;
let base;

const data = (o) => `data: ${JSON.stringify(o)}`;
const delta = (d, finish = null) => data({ choices: [{ index: 0, delta: d, finish_reason: finish }] });
const MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

before(async () => {
  fake = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const call = { method: req.method, path: req.url, auth: req.headers.authorization, title: req.headers["x-title"], body: body ? JSON.parse(body) : null };
    calls.push(call);
    const r = reply(call);
    if (r.lines) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(r.lines.map((l) => `${l}\n\n`).join(""));
    } else {
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.json));
    }
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${fake.address().port}/api/v1`;
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${fake.address().port}`; // health: Gemini's models.get answers 200 too

  const { handleApi } = await import("./api.mjs");
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
});

async function chat(body) {
  const r = await fetch(base + "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.headers.get("content-type")?.includes("event-stream")) return { status: r.status, json: await r.json() };
  const events = (await r.text())
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
  return { status: r.status, events };
}

const ask = (extra = {}) => ({ model: MODEL, messages: [{ role: "user", content: "hi" }], ...extra });
const ok = () => ({ lines: [delta({ content: "ok" }), delta({}, "stop"), "data: [DONE]"] });

describe("chat against OpenRouter", () => {
  test("both providers' models are offered, labelled by provider", async () => {
    const body = await (await fetch(base + "/api/models")).json();
    const providers = new Set(body.models.map((m) => m.provider));
    assert.deepEqual([...providers].sort(), ["Gemini API", "OpenRouter"]);
    assert.ok(body.models.some((m) => m.id === MODEL));
  });

  test("maps the request: system first, sampling, max_tokens, auth header, app title", async () => {
    reply = ok;
    await chat(ask({ system: "Be brief.", temperature: 0.3, topP: 0.9, maxTokens: 1000, messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }));
    const { path, auth, title, body } = calls[0];
    assert.equal(path, "/api/v1/chat/completions");
    assert.equal(auth, "Bearer sk-or-test-not-real");
    assert.equal(title, "Prometheus");
    assert.deepEqual(body.messages, [
      { role: "system", content: "Be brief." },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    assert.equal(body.model, MODEL);
    assert.equal(body.temperature, 0.3);
    assert.equal(body.top_p, 0.9);
    assert.equal(body.max_tokens, 1000);
    assert.equal(body.stream, true);
    assert.deepEqual(body.reasoning, { effort: "medium" }); // thinking on: effort for the task tier ("c" is a general task)
  });

  test("thinking off sends reasoning.enabled=false on toggle models only", async () => {
    reply = ok;
    await chat(ask({ thinking: false }));
    await chat(ask({ model: "cohere/north-mini-code:free", thinking: false }));
    assert.deepEqual(calls[0].body.reasoning, { enabled: false });
    assert.equal(calls[1].body.reasoning, undefined);
  });

  test("streams reasoning, content, usage and done; ignores keep-alive comments", async () => {
    reply = () => ({
      lines: [
        ": OPENROUTER PROCESSING",
        delta({ role: "assistant", reasoning: "Thinking…" }),
        delta({ content: "Hello" }),
        delta({ content: " world" }, "stop"),
        data({ choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 5, completion_tokens: 9, completion_tokens_details: { reasoning_tokens: 4 } } }),
        "data: [DONE]",
      ],
    });
    const { status, events } = await chat(ask({ maxTokens: 1000 }));
    assert.equal(status, 200);
    assert.equal(events[0].route.provider, "OpenRouter");
    delete events[0].route;
    assert.deepEqual(events, [
      { type: "start", model: MODEL, maxTokens: 1000, limitSeconds: 600 },
      { type: "reasoning", text: "Thinking…" },
      { type: "content", text: "Hello" },
      { type: "content", text: " world" },
      { type: "usage", usage: { prompt: 5, completion: 9, reasoning: 4 } },
      { type: "done", finishReason: "stop" },
    ]);
  });

  test("a mid-stream error is reported with the provider's message", async () => {
    reply = () => ({ lines: [delta({ content: "partial" }), data({ error: { code: 502, message: "Provider disconnected" }, choices: [{ delta: {}, finish_reason: "error" }] })] });
    const { events } = await chat(ask());
    const last = events.at(-1);
    assert.equal(last.type, "error");
    assert.equal(last.code, "upstream_error");
    // A stream that just stops (no finish reason) is reported too.
    reply = () => ({ lines: [delta({ content: "partial" })] });
    const again = await chat(ask());
    assert.match(again.events.at(-1).message, /OpenRouter stopped partway through/);
  });

  test("upstream errors are mapped without leaking the key", async () => {
    const cases = [
      [{ status: 401, json: { error: { message: "No auth credentials found", code: 401 } } }, 502, "auth_failed", /OPENROUTER_API_KEY/],
      [{ status: 402, json: { error: { message: "Insufficient credits", code: 402 } } }, 402, "payment_required", /credits/],
      [{ status: 429, json: { error: { message: "Provider returned error", code: 429, metadata: { raw: "model is temporarily rate-limited upstream" } } } }, 429, "rate_limited", /rate-limited upstream/],
      [{ status: 403, json: { error: { message: "only available on agentic harnesses", code: 403 } } }, 400, "invalid_request", /agentic harnesses/],
    ];
    for (const [r, status, code, text] of cases) {
      reply = () => r;
      const res = await chat(ask());
      assert.equal(res.status, status, code);
      assert.equal(res.json.error.code, code);
      assert.match(res.json.error.message, text);
      assert.doesNotMatch(JSON.stringify(res.json), /sk-or-test-not-real/);
    }
  });

  test("health checks every configured provider", async () => {
    reply = (c) => (c.path === "/api/v1/key" ? { status: 401, json: { error: { message: "User not found.", code: 401 } } } : { status: 200, json: { name: "models/gemini-3.8-flash" } });
    const r = await (await fetch(base + "/api/health?fresh")).json();
    // Gemini still works, so the app is usable: ok overall, with a warning naming the failing provider.
    assert.equal(r.status, "ok");
    assert.deepEqual(r.providers, { gemini: "ok", openrouter: "auth_failed" });
    assert.match(r.message, /Connected to Gemini API\. OpenRouter rejected OPENROUTER_API_KEY/);
  });
});
