// OpenRouter adapter (OpenAI-compatible chat completions). Emits the same events as gemini.mjs.
// Verified 2026-10-04 with a free-tier key: `reasoning: { enabled: false }` turns reasoning off on the
// toggle models, reasoning streams as `delta.reasoning`, and the stream may contain
// ": OPENROUTER PROCESSING" comment lines while a request is queued.

import { errorDetail, UpstreamError } from "./upstream.mjs";

// Every OpenRouter key the server knows, in fallback order. A model may name its own first choice
// (`keyEnv` in server/registry.mjs OVERRIDES); the others are tried when that key fails
// for a key-specific reason.
const KEY_ENVS = [
  { env: "OPENROUTER_API_KEY", name: "main" },
  { env: "OPENROUTER_API_KEY_BACKUP", name: "backup" },
  { env: "OPENROUTER_API_KEY_BACKUP_2", name: "second backup" },
];

function config() {
  return {
    keys: KEY_ENVS.map(({ env, name }) => ({ name, key: (process.env[env] ?? "").trim() })).filter((k) => k.key),
    base: (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
  };
}

/** Distinct keys for a model: its own key first (if set), then the rest in KEY_ENVS order. */
function keysFor(model, keys) {
  const own = model?.keyEnv ? (process.env[model.keyEnv] ?? "").trim() : "";
  return [...new Set([own, ...keys.map((k) => k.key)].filter(Boolean))];
}

// A key that failed for a key-specific reason is tried last for a while, so later requests don't
// each pay for a failed attempt first. Per process (an instance restart forgets it, which is harmless).
const KEY_BENCH_MS = 5 * 60_000;
const benchedUntil = new Map(); // key -> time

/**
 * Failures another key may not share: a rejected or disabled key, no credits, the key's own limit.
 * Not upstream rate limits ("…rate-limited upstream…": every key gets them) or bad requests.
 * Note: OpenRouter counts the free-model daily limit per account, so a backup key from the same
 * account runs out at the same time as the main one.
 */
function keySpecific(err) {
  if (err.status === 401 || err.status === 402) return true;
  if (err.status === 403) return /key|disabled|limit/i.test(err.detail);
  if (err.status === 429) return !/upstream/i.test(err.detail);
  return false;
}

/** Keys in the order to try them: benched keys last (still tried as a last resort). */
function keyOrder(keys) {
  const now = Date.now();
  const benched = (k) => (benchedUntil.get(k) ?? 0) > now;
  return [...keys.filter((k) => !benched(k)), ...keys.filter(benched)];
}

let budgetCache = null;

const headers = (key) => ({
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  "X-Title": "Prometheus", // app name in OpenRouter's activity log
});

async function fail(response) {
  return new UpstreamError(response.status, errorDetail(await response.text().catch(() => "")));
}

export const openrouterProvider = {
  id: "openrouter",
  label: "OpenRouter",
  vendor: "OpenRouter",
  keyEnv: "OPENROUTER_API_KEY",

  configured: () => config().keys.length > 0,

  /**
   * GET /key validates each key without spending any request quota. Healthy while any key works;
   * returns a warning naming any key that is rejected.
   */
  async check(_modelId, signal) {
    const { keys, base } = config();
    const results = await Promise.all(
      keys.map(async ({ key }) => {
        const r = await fetch(`${base}/key`, { headers: headers(key), signal });
        return r.ok ? null : await fail(r);
      }),
    );
    if (results.every(Boolean)) throw results[0];
    const warnings = results.flatMap((err, i) => (err ? [`OpenRouter ${keys[i].name} key was rejected (${err.status}).`] : []));
    return { warnings };
  },

  /**
   * Fraction of the account's free-model daily requests still available (GET /key, cached 60 s;
   * spends no quota). 1 when unknown. The router prefers other providers as this runs low.
   */
  async budget() {
    if (budgetCache && Date.now() - budgetCache.at < 60_000) return budgetCache.value;
    const { keys, base } = config();
    let value = 1;
    try {
      const r = await fetch(`${base}/key`, { headers: headers(keys[0].key), signal: AbortSignal.timeout(3_000) });
      const q = r.ok ? (await r.json()).data?.free_model_daily_requests : null;
      if (q?.limit > 0) value = Math.max(0, q.remaining) / q.limit;
    } catch {
      // unknown: don't penalize
    }
    budgetCache = { at: Date.now(), value };
    return value;
  },

  /** effort: null (model default) | "off" (`reasoning.enabled: false`) | a level from model.efforts. */
  async open({ model, messages, system, temperature, topP, maxTokens, effort, signal }) {
    const { keys: all, base } = config();
    const keys = keysFor(model, all);
    const payload = {
      model: model.id,
      messages: system ? [{ role: "system", content: system }, ...messages] : messages,
      temperature,
      top_p: topP,
      max_tokens: maxTokens,
      stream: true,
    };
    if (effort === "off" && model.reasoning === "toggle") payload.reasoning = { enabled: false };
    else if (effort && effort !== "off") payload.reasoning = { effort };

    const order = keyOrder(keys);
    for (const [i, key] of order.entries()) {
      const response = await fetch(`${base}/chat/completions`, { method: "POST", headers: headers(key), body: JSON.stringify(payload), signal });
      if (response.ok) {
        benchedUntil.delete(key);
        return { maxTokens, events: events(response.body, signal) };
      }
      const err = await fail(response);
      // A model that rejects the reasoning setting gets one retry without it (same key).
      if (err.status === 400 && payload.reasoning && /reason|effort/i.test(err.detail)) {
        delete payload.reasoning;
        const again = await fetch(`${base}/chat/completions`, { method: "POST", headers: headers(key), body: JSON.stringify(payload), signal });
        if (again.ok) return { maxTokens, events: events(again.body, signal) };
        throw await fail(again);
      }
      if (!keySpecific(err) || i === order.length - 1) throw err;
      benchedUntil.set(key, Date.now() + KEY_BENCH_MS); // try the next key
    }
  },
};

async function* events(body, signal) {
  const decoder = new TextDecoder();
  let buffer = "";
  let finishReason = null;
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) {
        if (line.startsWith(":")) yield { type: "alive" }; // queue keep-alive comment
        continue;
      }
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      // A failure after streaming started: { error: { code, message }, choices: [{ finish_reason: "error" }] }
      if (json.error) throw new UpstreamError(Number(json.error.code) || 0, errorDetail(JSON.stringify(json)), Number(json.error.code) ? undefined : "midstream");
      const choice = json.choices?.[0];
      const delta = choice?.delta ?? {};
      let sent = false;
      if (delta.reasoning) {
        sent = true;
        yield { type: "reasoning", text: delta.reasoning };
      }
      if (delta.content) {
        sent = true;
        yield { type: "content", text: delta.content };
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (json.usage) {
        sent = true;
        yield {
          type: "usage",
          usage: {
            prompt: json.usage.prompt_tokens ?? null,
            completion: json.usage.completion_tokens ?? null,
            reasoning: json.usage.completion_tokens_details?.reasoning_tokens || null,
          },
        };
      }
      if (!sent) yield { type: "alive" };
    }
  }
  if (signal.aborted) return;
  if (!finishReason || finishReason === "error") throw new UpstreamError(0, "", "midstream");
  yield { type: "finish", reason: finishReason };
}
