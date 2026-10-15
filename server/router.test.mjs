// Router unit tests (no network): classification, tiers, capability filters, token limits, effort
// levels, health and recovery. Uses the real catalog snapshot plus synthetic models for edge cases.
// Run: npm test
import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.MODEL_REGISTRY_LIVE = "false";
const { getRegistry, buildModels } = await import("./registry.mjs");
const { classify } = await import("./router/classify.mjs");
const { plan, effortFor, reasonFor } = await import("./router/route.mjs");
const health = await import("./router/health.mjs");
const { planMaxTokens } = await import("./tokens.mjs");

const { models } = await getRegistry();
const byId = (id) => models.find((m) => m.id === id);
const ask = (content, extra = {}) => ({ messages: [{ role: "user", content }], maxTokens: 4000, thinking: true, ...extra });
const top = (req, list = models, ctx) => plan(req, list, ctx).candidates[0].model;
const synthetic = (id, over = {}) => ({ id, provider: "gemini", label: id, vendor: "X", contextWindow: 128_000, maxOutput: 32_000, reasoning: "toggle", efforts: ["minimal", "low", "medium", "high"], vision: false, tools: true, streaming: true, free: true, price: { input: 0, output: 0 }, quality: { intelligence: 30, coding: 60 }, ...over });

beforeEach(() => health.resetHealth());

describe("registry", () => {
  test("snapshot has both providers, normalized, with real limits", () => {
    assert.ok(models.some((m) => m.provider === "gemini") && models.some((m) => m.provider === "openrouter"));
    for (const m of models) {
      assert.ok(m.contextWindow > 0 && m.maxOutput > 0, m.id);
      assert.ok(["toggle", "always", "none"].includes(m.reasoning), m.id);
      assert.ok(m.description.length > 0, m.id);
    }
    assert.equal(byId("cohere/north-mini-code:free").reasoning, "always", "verified quirk override");
  });

  test("discovery rules: newest Gemini generation, no paid Pro on the free tier, denylisted OpenRouter models out", () => {
    const built = buildModels({
      geminiModels: [
        { name: "models/gemini-4.0-flash", displayName: "Gemini 4.0 Flash", inputTokenLimit: 1e6, outputTokenLimit: 65536, thinking: true, supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-4.0-pro", displayName: "Gemini 4.0 Pro", inputTokenLimit: 1e6, outputTokenLimit: 65536, thinking: true, supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", inputTokenLimit: 1e6, outputTokenLimit: 65536, thinking: true, supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-4.0-flash-tts", displayName: "TTS", inputTokenLimit: 8192, outputTokenLimit: 16384, supportedGenerationMethods: ["generateContent"] },
      ],
      openrouterModels: [
        { id: "a/new-model:free", name: "A: New (free)", context_length: 200_000, architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" }, top_provider: { max_completion_tokens: 32_000 }, supported_parameters: ["reasoning"], benchmarks: { artificial_analysis: { intelligence_index: 20 } } },
        { id: "b/no-benchmarks:free", name: "B: X (free)", context_length: 200_000, architecture: { output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } },
        { id: "thinkingmachines/inkling:free", name: "T: Inkling (free)", context_length: 1e6, architecture: { output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" }, benchmarks: { artificial_analysis: { intelligence_index: 25 } } },
      ],
    });
    assert.deepEqual(built.map((m) => m.id), ["gemini-4.0-flash", "a/new-model:free"]);
    assert.equal(built[1].label, "New");
    assert.equal(built[1].vendor, "A");
  });
});

describe("classification", () => {
  const cases = [
    ["hi", "simple", "fast"],
    ["What is the capital of Japan?", "simple", "fast"],
    ["Reply with just the word OK.", "simple", "fast"],
    ["Rewrite this sentence to sound formal: hey send me the file", "rewrite", "fast"],
    ["Give me some tips for staying focused while studying.", "general", "general"],
    ["Write a short poem about rain.", "creative", "general"],
    ["Write a Python function that merges two sorted lists.", "coding", "general"],
    ["Prove that the square root of 2 is irrational.", "math", "advanced"],
    ["Design a distributed rate limiter architecture that is scalable, handles race conditions and edge cases.", "reasoning", "advanced"],
  ];
  for (const [text, type, tier] of cases) {
    test(`${JSON.stringify(text.slice(0, 40))} → ${type}/${tier}`, () => {
      const t = classify(ask(text));
      assert.equal(t.type, type);
      assert.equal(t.tier, tier);
    });
  }
  test("a short follow-up inherits the previous task", () => {
    const t = classify({ messages: [{ role: "user", content: "Write a Rust function to parse JSON" }, { role: "assistant", content: "…" }, { role: "user", content: "and in Go?" }] });
    assert.equal(t.type, "coding");
    assert.ok(t.signals.includes("follow-up of coding"));
  });
  test("large attachments make a long-document task", () => {
    const doc = `<file name="report.txt">\n${"lorem ipsum ".repeat(8000)}\n</file>\n\nSummarize this`;
    assert.equal(classify(ask(doc)).type, "long-document");
  });
});

describe("routing tiers (real snapshot data)", () => {
  test("simple request → a fast, low-benchmark-need model, not the strongest", () => {
    const m = top(ask("What is the capital of Japan?"));
    const best = Math.max(...models.map((x) => x.quality?.intelligence ?? 0));
    assert.ok((m.quality?.intelligence ?? 0) < best, `${m.id} should not be the strongest model`);
  });
  test("complex reasoning → the model with the highest intelligence index", () => {
    const m = top(ask("Design a distributed rate limiter architecture that is scalable, handles race conditions and edge cases."));
    const best = Math.max(...models.map((x) => x.quality?.intelligence ?? 0));
    assert.equal(m.quality.intelligence, best);
  });
  test("hard coding → judged by the coding index", () => {
    const d = plan(ask("Refactor this complex concurrent Python scheduler for performance and fix the race condition in it from scratch: ```py\nx=1\n```"), models);
    assert.equal(d.need.quality, "coding");
    const bestCoding = Math.max(...models.map((x) => x.quality?.coding ?? 0));
    assert.equal(d.candidates[0].model.quality.coding, bestCoding);
  });
  test("decisions are deterministic", () => {
    const req = ask("Write a short poem about rain.");
    assert.deepEqual(plan(req, models).candidates.map((c) => c.model.id), plan(req, models).candidates.map((c) => c.model.id));
  });
  test("low shared free quota moves free OpenRouter models down", () => {
    const req = ask("Give me some tips for staying focused while studying.");
    const rank = (ctx) => plan(req, models, ctx).candidates.findIndex((c) => c.model.id === "qwen/qwen3.8-27b:free");
    assert.ok(rank({ budget: { openrouter: 0 } }) > rank({ budget: { openrouter: 1 } }));
  });
  test("a paid model never wins on price alone, but capability beats cost", () => {
    const cheapWeak = synthetic("weak", { quality: { intelligence: 10, coding: 20 } });
    const paidStrong = synthetic("strong", { free: false, price: { input: 1, output: 3 }, quality: { intelligence: 40, coding: 80 } });
    assert.equal(top(ask("Prove that the square root of 2 is irrational."), [cheapWeak, paidStrong]).id, "strong");
  });
  test("the reason never claims 'highest benchmark' unless true", () => {
    const d = plan(ask("Give me some tips for staying focused while studying."), models);
    const r = reasonFor(d, d.candidates[0]);
    if (d.candidates[0].parts.quality !== 1) assert.doesNotMatch(r, /highest/);
  });
});

describe("capability filters", () => {
  test("vision request → only image-capable models", () => {
    const d = plan(ask("What is in this picture?", { images: 1 }), models);
    assert.ok(d.candidates.length > 0);
    assert.ok(d.candidates.every((c) => c.model.vision));
    assert.ok(d.excluded.some((e) => e.reason === "no image input"));
  });
  test("long context → models that can't fit the prompt are excluded", () => {
    const small = synthetic("small-ctx", { contextWindow: 32_000 });
    const big = synthetic("big-ctx", { contextWindow: 1_000_000 });
    const req = ask("x".repeat(150_000)); // ~50K tokens at 3 chars/token
    const d = plan(req, [small, big]);
    assert.deepEqual(d.candidates.map((c) => c.model.id), ["big-ctx"]);
    assert.match(d.excluded[0].reason, /context/);
  });
  test("no model fits → empty candidate list (the API explains why)", () => {
    const d = plan(ask("x".repeat(150_000)), [synthetic("tiny", { contextWindow: 8_000 })]);
    assert.equal(d.candidates.length, 0);
  });
  test("a model that can't write enough output is excluded", () => {
    const d = plan(ask("hi", { maxTokens: 50_000 }), [synthetic("short-out", { maxOutput: 2048 }), synthetic("long-out", { maxOutput: 65_536 })]);
    assert.deepEqual(d.candidates.map((c) => c.model.id), ["long-out"]);
  });
});

describe("token limits", () => {
  const m = byId("gemini-3.8-flash");
  for (const want of [4_000, 8_000, 16_000, 32_000, 50_000]) {
    test(`${want} requested → ${want} sent (within the model's 65,536)`, () => assert.equal(planMaxTokens(m, want, 100), want));
  }
  test("above the 300K app cap → 300K", () => assert.equal(planMaxTokens(synthetic("big", { maxOutput: 1_000_000, contextWindow: 2_000_000 }), 500_000, 100), 300_000));
  test("above the model's own maximum → that maximum (Gemini 65,536)", () => assert.equal(planMaxTokens(m, 300_000, 100), 65_536));
  test("model-specific lower limit → reduced safely", () => assert.equal(planMaxTokens(synthetic("x", { maxOutput: 8_192 }), 50_000, 100), 8_192));
  test("long conversation → reduced to the context left", () => {
    const n = planMaxTokens(synthetic("x", { contextWindow: 128_000, maxOutput: 65_536 }), 50_000, 300_000);
    assert.ok(n < 50_000 && n > 20_000, `got ${n}`);
  });
  test("long output requests prefer models that can write it", () => {
    const d = plan(ask("Write a detailed guide.", { maxTokens: 50_000 }), models);
    assert.ok(d.candidates[0].model.maxOutput >= 50_000);
  });
});

describe("reasoning effort", () => {
  const g38 = byId("gemini-3.8-flash");
  const lite = byId("gemini-3.5-flash-lite");
  test("by tier when thinking is on, nearest supported level", () => {
    assert.equal(effortFor(lite, "fast", true), "low");
    assert.equal(effortFor(lite, "general", true), "medium");
    assert.equal(effortFor(g38, "advanced", true), "high");
    assert.equal(effortFor(byId("nvidia/nemotron-3-super-120b-a12b:free"), "advanced", true), "medium"); // supports low/medium only
  });
  test("thinking off: 'off' where the model can stop thinking, else its lowest level", () => {
    assert.equal(effortFor(lite, "general", false), "off");
    assert.equal(effortFor(g38, "general", false), "low");
  });
});

describe("health", () => {
  test("a failing model cools down, is skipped, and recovers", () => {
    let t = 0;
    health.resetHealth(() => t);
    const req = ask("Design a distributed rate limiter architecture that is scalable, handles race conditions and edge cases.");
    const first = top(req);
    health.recordFailure(first.id, "overloaded");
    assert.notEqual(top(req).id, first.id, "cooling model is skipped");
    assert.ok(plan(req, models).excluded.some((e) => e.id === first.id && /cooling/.test(e.reason)));
    t += 21_000; // past the first 20 s cooldown
    assert.equal(top(req).id, first.id, "eligible again after the cooldown");
    health.recordSuccess(first.id, { ttftMs: 800 });
    assert.equal(health.status(first), "ok");
  });
  test("cooldowns grow with consecutive failures", () => {
    let t = 0;
    health.resetHealth(() => t);
    const m = byId("gemini-3.8-flash");
    health.recordFailure(m.id, "overloaded");
    t += 21_000;
    assert.equal(health.coolingReason(m), null);
    health.recordFailure(m.id, "overloaded"); // second in a row: 40 s
    t += 21_000;
    assert.equal(health.coolingReason(m), "overloaded");
  });
  test("provider quota exhaustion cools only that provider's free models", () => {
    health.recordProviderFailure("openrouter", "quota", { scope: "free" });
    assert.ok(health.coolingReason(byId("qwen/qwen3.8-27b:free")));
    assert.equal(health.coolingReason(synthetic("paid", { provider: "openrouter", free: false })), null, "a paid model isn't affected");
    assert.equal(health.coolingReason(byId("gemini-3.8-flash")), null);
  });
  test("when every model is cooling, they are still tried (no dead end)", () => {
    for (const m of models) health.recordFailure(m.id, "overloaded");
    assert.ok(plan(ask("hi"), models).candidates.length > 0);
  });
  test("measured latency favors the faster of two equal models", () => {
    const a = synthetic("a");
    const b = synthetic("b");
    health.recordSuccess("a", { ttftMs: 9_000 });
    health.recordSuccess("b", { ttftMs: 500 });
    assert.equal(top(ask("hi"), [a, b]).id, "b");
  });
  test("health keeps no personal data", () => {
    health.recordSuccess("gemini-3.8-flash", { ttftMs: 1000 });
    assert.doesNotMatch(JSON.stringify(health.snapshot()), /\d+\.\d+\.\d+\.\d+|user|message|content/i);
  });
});
