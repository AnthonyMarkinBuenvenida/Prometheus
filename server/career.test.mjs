// Career Guidance Factory: POST /api/career runs four agents in one stream, against a fake server
// that plays both providers. Covers order and hand-off between agents, the one-message rate limit,
// validation, resuming, failures, fallback and Stop.
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

const { AGENTS, agentMessages, validateProfile, validateResume } = await import("./career.mjs");

/** behaviour(call) → "ok" | "answer-fail" (some answer text, then the stream dies) | "slow" (pauses after thinking) | { status, json } */
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
    const agent = /You are the ([A-Za-z ]+?) Agent/.exec(body)?.[1] ?? "?";
    const call = { provider: isGemini ? "gemini" : "openrouter", model, agent, body, n: calls.length, ended: false };
    calls.push(call);
    const b = behaviour(call);
    if (typeof b === "object") {
      call.ended = true;
      return res.writeHead(b.status, { "Content-Type": "application/json" }).end(JSON.stringify(b.json));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const answer = `${agent} result by ${model}`;
    if (isGemini) {
      res.write(gem({ candidates: [{ content: { role: "model", parts: [{ text: `thinking about ${agent}`, thought: true }] } }] }));
      if (b === "slow") await new Promise((r) => setTimeout(r, 1500));
      res.write(gem({ candidates: [{ content: { role: "model", parts: [{ text: answer }] } }] }));
      if (b === "answer-fail") return res.end();
      res.end(gem({ candidates: [{ content: { parts: [] }, finishReason: "STOP" }] }));
    } else {
      res.write(or({ choices: [{ delta: { content: answer }, finish_reason: null }] }));
      if (b === "answer-fail") return res.end();
      res.end(or({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
    }
    call.ended = true;
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

const PROFILE = {
  skills: "Python, Java, SQL, data structures, Git",
  interests: "AI, data, building web apps",
  education: "3rd-year BS Computer Science student",
  goals: "Land an internship next year and become a machine learning engineer",
  location: "Manila, Philippines",
};
const request = (extra = {}) => ({ model: "gemini-3.6-flash", profile: PROFILE, thinking: true, ...extra });

async function post(path, body) {
  const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.headers.get("content-type")?.includes("event-stream")) return { status: r.status, json: await r.json(), events: [] };
  const events = (await r.text())
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)));
  return { status: r.status, events };
}
const career = (body) => post("/api/career", body);

describe("career module", () => {
  test("four agents in order, each with its own instructions", () => {
    assert.deepEqual(AGENTS.map((a) => a.id), ["skills", "career", "learning", "jobs"]);
    for (const a of AGENTS) assert.match(a.system, new RegExp(`You are the ${a.name}`));
    // Only the agents whose items become search links end with a JSON block.
    assert.deepEqual(AGENTS.filter((a) => a.system.includes("```json")).map((a) => a.id), ["learning", "jobs"]);
  });

  test("each agent sees the profile and every earlier agent's output, not later ones", () => {
    const outputs = { skills: "S-OUT", career: "C-OUT", learning: "L-OUT" };
    const [m] = agentMessages(2, validateProfile(PROFILE), outputs);
    assert.equal(m.role, "user");
    assert.match(m.content, /Skills: Python, Java/);
    assert.match(m.content, /Skills Agent output\nS-OUT/);
    assert.match(m.content, /Career Agent output\nC-OUT/);
    assert.doesNotMatch(m.content, /L-OUT/);
    assert.match(m.content, /Do your part as the Learning Agent/);
  });

  test("profile validation: skills required, text only, length limits, optional fields filled", () => {
    assert.throws(() => validateProfile({ skills: "  " }), /Skills is required/);
    assert.throws(() => validateProfile({ skills: 42 }), /must be text/);
    assert.throws(() => validateProfile({ skills: "x".repeat(3001) }), /too long/);
    assert.deepEqual(validateProfile({ skills: " Go " }), { skills: "Go", interests: "", education: "", goals: "", location: "" });
  });

  test("resume validation needs the earlier agents' results", () => {
    assert.deepEqual(validateResume(undefined, undefined), { start: 0, outputs: {} });
    assert.throws(() => validateResume(2, { skills: "s" }), /Career Agent's earlier result is missing/);
    assert.throws(() => validateResume(4, {}), /Invalid starting agent/);
    assert.throws(() => validateResume(1.5, {}), /Invalid starting agent/);
    assert.deepEqual(validateResume(1, { skills: "s", career: "ignored" }), { start: 1, outputs: { skills: "s" } });
  });
});

describe("POST /api/career", () => {
  // Runs first: no other request has used this minute's window yet.
  test("a whole run (four model calls) counts as one message", async () => {
    process.env.RATE_LIMIT_CHAT_PER_MIN = "1";
    try {
      const first = await career(request());
      assert.equal(first.status, 200);
      assert.equal(first.events.at(-1).type, "done");
      assert.equal(calls.length, 4);
      const second = await career(request());
      assert.equal(second.status, 429);
      assert.equal(calls.length, 4);
    } finally {
      process.env.RATE_LIMIT_CHAT_PER_MIN = "1000";
    }
  });

  test("runs the four agents in order and hands each result to the next", async () => {
    const { status, events } = await career(request());
    assert.equal(status, 200);
    assert.deepEqual(calls.map((c) => c.agent), ["Skills", "Career", "Learning", "Job Matching"]);
    assert.ok(calls.every((c) => c.model === "gemini-3.6-flash"));
    // The Learning Agent's prompt carries the Skills and Career results.
    assert.match(calls[2].body, /Skills result by gemini-3.6-flash/);
    assert.match(calls[2].body, /Career result by gemini-3.6-flash/);

    const lifecycle = events.filter((e) => e.type === "start" || e.type === "agent-done" || e.type === "done").map((e) => `${e.type}:${e.agent ?? "-"}`);
    assert.deepEqual(lifecycle, ["start:skills", "agent-done:skills", "start:career", "agent-done:career", "start:learning", "agent-done:learning", "start:jobs", "agent-done:jobs", "done:-"]);
    const content = events.filter((e) => e.type === "content");
    assert.deepEqual(content.map((e) => e.agent), ["skills", "career", "learning", "jobs"]);
    assert.ok(events.filter((e) => e.type === "reasoning").every((e) => e.agent));
    assert.equal(events.find((e) => e.type === "start").route.reason, "You chose Gemini 3.6 Flash.");
  });


  test("invalid profile or resume → 400 before any model call", async () => {
    const r1 = await career(request({ profile: { skills: "" } }));
    assert.equal(r1.status, 400);
    assert.match(r1.json.error.message, /Skills is required/);
    const r2 = await career(request({ from: 2, previous: { skills: "s" } }));
    assert.equal(r2.status, 400);
    const r3 = await career(request({ model: "no-such-model" }));
    assert.equal(r3.status, 400);
    assert.equal(r3.json.error.code, "invalid_model");
    assert.equal(calls.length, 0);
  });

  test("resume from the Learning Agent with the earlier results", async () => {
    const { events } = await career(request({ from: 2, previous: { skills: "EARLIER-SKILLS", career: "EARLIER-CAREERS" } }));
    assert.deepEqual(calls.map((c) => c.agent), ["Learning", "Job Matching"]);
    assert.match(calls[0].body, /EARLIER-SKILLS/);
    assert.match(calls[0].body, /EARLIER-CAREERS/);
    assert.equal(events.at(-1).type, "done");
  });

  test("an agent failing mid-answer ends the run with an error for that agent", async () => {
    behaviour = (c) => (c.agent === "Career" ? "answer-fail" : "ok");
    const { events } = await career(request({ allowFallback: true }));
    assert.deepEqual(calls.map((c) => c.agent), ["Skills", "Career"]); // never switches once text streamed
    const last = events.at(-1);
    assert.equal(last.type, "error");
    assert.equal(last.agent, "career");
    assert.ok(!events.some((e) => e.type === "done"));
  });

  test("the first agent failing before anything streamed → JSON error", async () => {
    behaviour = () => ({ status: 503, json: busy });
    const r = await career(request());
    assert.equal(r.status, 503);
    assert.equal(r.json.error.code, "upstream_busy");
    assert.equal(calls.length, 1);
  });

  test("a later agent failing before answering → error event, no fallback when it's off", async () => {
    behaviour = (c) => (c.agent === "Learning" ? { status: 503, json: busy } : "ok");
    const { status, events } = await career(request());
    assert.equal(status, 200);
    assert.deepEqual(calls.map((c) => c.agent), ["Skills", "Career", "Learning"]);
    assert.deepEqual(events.at(-1), { type: "error", message: "Gemini API is under high demand right now. Try again in a moment or pick another model.", code: "upstream_busy", agent: "learning" });
  });

  test("with fallback on, another model takes over that agent and the run continues", async () => {
    behaviour = (c) => (c.agent === "Learning" && c.model === "gemini-3.6-flash" ? { status: 503, json: busy } : "ok");
    const { events } = await career(request({ allowFallback: true }));
    const learning = calls.filter((c) => c.agent === "Learning");
    assert.equal(learning.length, 2);
    assert.notEqual(learning[1].model, "gemini-3.6-flash");
    const start = events.find((e) => e.type === "start" && e.agent === "learning");
    assert.deepEqual(start.route.fallbackFrom, ["Gemini 3.6 Flash"]);
    assert.equal(calls.at(-1).agent, "Job Matching");
    assert.equal(events.at(-1).type, "done");
  });

  test("Stop during an agent: no later agent starts", async () => {
    behaviour = (c) => (c.agent === "Career" ? "slow" : "ok");
    const ctrl = new AbortController();
    const r = await fetch(base + "/api/career", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request()), signal: ctrl.signal });
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // Stop while the Career Agent is thinking.
    while (!/"type":"reasoning"[^}]*"agent":"career"/.test(text)) text += decoder.decode((await reader.read()).value);
    ctrl.abort();
    await new Promise((res) => setTimeout(res, 2000));
    assert.deepEqual(calls.map((c) => c.agent), ["Skills", "Career"]);
  });
});
