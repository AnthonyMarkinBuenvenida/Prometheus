// Routing decision: classify → requirements → filter incompatible models → score → ordered candidates.
// Pure and deterministic for a given (request, registry, health) so decisions can be reproduced
// and tested. The score is an internal ranking, not a benchmark; it is never shown as one.
//
// Score components (0..1 each, weights depend on the tier):
//   fit         quality vs. what the task needs. Quality = Artificial Analysis index (coding index for
//               coding/debugging, intelligence index otherwise) normalized to the best eligible model.
//               Below the need is penalized hard; above it is penalized mildly for easy tasks, so a
//               cheap/small model wins when it is enough ("cheapest model that can do the job").
//               Unknown quality → an uncertain middle value, never the top.
//   reliability measured success rate in the rolling health window (0.5 with no data)
//   latency     measured time to first token (0.5 with no data)
//   cost        what this deployment pays per output token (free = 1)
//   budget      remaining shared free quota (OpenRouter's free-model daily requests), 1 when not limited
// Bonuses: continuation stickiness, reasoning support for hard tasks, output headroom.

import { EFFORT_SCALE } from "../registry.mjs";
import { classify } from "./classify.mjs";
import { coolingReason, stats } from "./health.mjs";

export const MAX_ATTEMPTS = () => Math.max(1, Math.min(5, Number(process.env.ROUTER_MAX_ATTEMPTS) || 3));

// Fraction of the best eligible model's benchmark a tier needs. Advanced = the best available.
const NEED = { fast: 0.5, general: 0.75, advanced: 1 };
const OVERKILL = { fast: 0.8, general: 0.3, advanced: 0 };
const WEIGHTS = {
  fast: { fit: 0.45, reliability: 0.15, latency: 0.2, cost: 0.1, budget: 0.1 },
  general: { fit: 0.55, reliability: 0.15, latency: 0.1, cost: 0.1, budget: 0.1 },
  advanced: { fit: 0.65, reliability: 0.15, latency: 0.05, cost: 0.05, budget: 0.1 },
};
const UNKNOWN_FIT = { fast: 0.8, general: 0.5, advanced: 0.2 };
const CODE_TASKS = new Set(["coding", "debugging"]);
const MIN_OUTPUT = 4096; // a model must be able to write at least this much (or the request, if smaller)

const round = (x) => Math.round(x * 1000) / 1000;

/** Requirements derived from the request and its classification. */
export function requirements(req, task) {
  const outputTokens = Math.max(256, Math.min(Number(req.maxTokens) || 4096, Number(process.env.MAX_OUTPUT_TOKENS) || 300_000));
  return {
    promptTokens: task.promptTokens,
    outputTokens,
    minOutput: Math.min(outputTokens, MIN_OUTPUT),
    vision: Boolean(req.images),
    reasoning: task.tier === "advanced" || task.type === "math" || task.type === "debugging",
    streaming: true,
    quality: CODE_TASKS.has(task.type) ? "coding" : "intelligence",
  };
}

/** Why a model can't take this request, or null. */
function incompatibility(m, need) {
  if (!m.streaming) return "no streaming";
  if (need.vision && !m.vision) return "no image input";
  if (m.maxOutput < need.minOutput) return `max output ${m.maxOutput} < ${need.minOutput}`;
  if (m.contextWindow && need.promptTokens + need.minOutput + 256 > m.contextWindow) return `context ${m.contextWindow} too small for ~${need.promptTokens} prompt tokens`;
  return null;
}

const qualityValue = (m, kind) => m.quality?.[kind] ?? (kind === "coding" ? m.quality?.intelligence : null) ?? null;

/** Reasoning effort to request: by tier when thinking is on, the model's lowest level when off. */
export function effortFor(m, tier, thinking) {
  if (m.reasoning === "none") return null;
  if (thinking === false) return m.reasoning === "toggle" ? "off" : (m.efforts[0] ?? null);
  const want = tier === "fast" ? "low" : tier === "advanced" ? "high" : "medium";
  if (!m.efforts.length) return null; // provider default
  // Nearest supported level, preferring the lower one on ties.
  return [...m.efforts].sort((a, b) => Math.abs(EFFORT_SCALE.indexOf(a) - EFFORT_SCALE.indexOf(want)) - Math.abs(EFFORT_SCALE.indexOf(b) - EFFORT_SCALE.indexOf(want)) || EFFORT_SCALE.indexOf(a) - EFFORT_SCALE.indexOf(b))[0];
}

/**
 * @param {object} req      { messages, system, maxTokens, thinking, images?, continuation?, previousModel? }
 * @param {object[]} models registry models whose provider is configured
 * @param {{ budget?: Record<string, number> }} [ctx] remaining free-quota fraction per provider
 */
export function plan(req, models, ctx = {}) {
  const task = classify(req);
  const need = requirements(req, task);
  const excluded = [];
  let eligible = [];
  for (const m of models) {
    const why = incompatibility(m, need);
    if (why) excluded.push({ id: m.id, reason: why });
    else eligible.push(m);
  }
  // Cooling-down models are skipped while others remain; if every model is cooling, try them anyway.
  const cool = eligible.filter((m) => coolingReason(m));
  if (cool.length < eligible.length) {
    for (const m of cool) excluded.push({ id: m.id, reason: `cooling down (${coolingReason(m)})` });
    eligible = eligible.filter((m) => !coolingReason(m));
  }

  const best = Math.max(0, ...eligible.map((m) => qualityValue(m, need.quality) ?? 0));
  const ttfts = eligible.map((m) => stats(m.id).ttftMs).filter((x) => x !== null);
  const fastest = ttfts.length ? Math.min(...ttfts) : null;
  const w = WEIGHTS[task.tier];

  const scored = eligible.map((m) => {
    const q = qualityValue(m, need.quality);
    const quality = q === null || best === 0 ? null : q / best;
    const target = NEED[task.tier];
    const fit = quality === null ? UNKNOWN_FIT[task.tier] : quality >= target ? 1 - OVERKILL[task.tier] * (quality - target) : Math.max(0, 1 - 2 * (target - quality));
    const h = stats(m.id);
    const latency = h.ttftMs === null || fastest === null ? 0.5 : Math.max(0, 1 - (h.ttftMs - fastest) / 20_000);
    const cost = m.free ? 1 : 1 / (1 + m.price.output); // $/M output; e.g. $2.40 → 0.29
    const budget = m.free ? (ctx.budget?.[m.provider] ?? 1) : 1;
    let score = w.fit * fit + w.reliability * h.successRate + w.latency * latency + w.cost * cost + w.budget * budget;
    const bonus = [];
    if (need.reasoning && m.reasoning !== "none") (score += 0.03), bonus.push("reasoning");
    if (m.maxOutput >= need.outputTokens) (score += 0.02), bonus.push("output");
    if (req.previousModel === m.id && (req.continuation || task.signals.some((s) => s.startsWith("follow-up")))) {
      score += req.continuation ? 1 : 0.05; // Continue must stay on the model that wrote the answer
      bonus.push("same model as previous answer");
    }
    return { model: m, score: round(score), parts: { fit: round(fit), quality: quality === null ? null : round(quality), reliability: round(h.successRate), latency: round(latency), cost: round(cost), budget: round(budget) }, bonus };
  });
  // Deterministic order: score, then registry order.
  scored.sort((a, b) => b.score - a.score || models.indexOf(a.model) - models.indexOf(b.model));
  return { task, need, candidates: scored, excluded };
}

/** One sentence for users: why this model (no scores). `entry` is the chosen scored candidate. */
export function reasonFor(decision, entry, { fallbackFrom = [], manual = false } = {}) {
  const chosen = entry.model;
  if (manual && fallbackFrom.length) return `Your chosen model (${fallbackFrom[0]}) was unavailable, so ${chosen.label} answered instead (fallback is on in Settings).`;
  if (manual) return `You chose ${chosen.label}.`;
  const { task, need } = decision;
  const what = {
    simple: "a quick question",
    rewrite: "a rewrite",
    summarization: "a summary",
    creative: "creative writing",
    general: "a general request",
    structured: "structured output",
    "data-analysis": "data analysis",
    coding: "a coding task",
    reasoning: "a reasoning task",
    math: "math",
    debugging: "debugging",
    "long-document": "a long document",
    multimodal: "an image request",
  }[task.type];
  const top = entry.parts.quality === 1;
  const why = entry.bonus.includes("same model as previous answer") && decision.task.signals.includes("continuation")
    ? "it wrote the answer being continued"
    : task.tier === "fast"
      ? "a fast, efficient model is enough"
      : top
        ? `it has the highest ${need.quality === "coding" ? "coding" : "intelligence"} benchmark among the available models`
        : "it is the best balance of benchmark quality, speed, cost and availability right now";
  const fb = fallbackFrom.length ? ` (${fallbackFrom.join(" and ")} didn't answer, so the next best was used)` : "";
  return `${what[0].toUpperCase()}${what.slice(1)} — chose ${chosen.label} because ${why}${fb}.`;
}
