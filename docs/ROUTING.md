# Model routing and fallback

**There is no automatic model selection.** Auto mode (picking a model per message) was removed on 2026-10-15 at the user's request, because it kept landing on overloaded Gemini models. The user chooses the model; the default is `DEFAULT_MODEL`, else `gemini-3.6-flash`. A request with no model — or `"auto"` from a page loaded before the change — gets the default model.

The router below is still used for two things: the **thinking effort** (from the task's difficulty) and, only when the user turns on *Fall back if my chosen model fails* (off by default), **ranking the other models to try** if the chosen one fails. Sections describing selection apply to that fallback ranking.

```
Browser ──▶ POST /api/chat { model: <id>, allowFallback?, … }
              │
              ▼
        server/api.mjs ── streams, timers, failover loop, SSE to the browser
              │
   ┌──────────┼──────────────────────────────┐
   ▼          ▼                              ▼
registry.mjs  router/                        providers/
 live model   classify.mjs  task + tier       gemini.mjs      (@google/genai)
 catalogs     route.mjs     filter + score    openrouter.mjs  (OpenAI-compatible)
 (+snapshot)  health.mjs    rolling health    upstream.mjs    UpstreamError
```

The browser never sees provider formats or keys: it sends `model: "auto"` (or an id) and receives the same event stream for every provider.

## 1. Model registry (`server/registry.mjs`)

Models are **discovered by rules** from the providers' live catalogs, refreshed hourly per server instance:

| Provider | Source | Included when |
|---|---|---|
| Gemini | `models.list` (needs the key) | a plain chat family (`gemini-X.Y-flash`, `-flash-lite`, `-pro`), newest generation only (`GEMINI_MIN_VERSION` to override), no Pro on the free tier (`GEMINI_TIER=paid` to include) |
| OpenRouter | `GET /api/v1/models` (public) | a `:free` text model with an Artificial Analysis intelligence index, not in `OPENROUTER_EXCLUDE`; plus `OPENROUTER_EXTRA_MODELS` (paid models added on purpose; none by default) |

Each model is normalized to one shape: context window, max output, reasoning mode (`toggle`/`always`/`none`) and supported effort levels, vision, tools, streaming, price (what this deployment pays — Gemini's free tier counts as $0), and **quality = Artificial Analysis intelligence and coding indices** as published in OpenRouter's catalog (Gemini models are matched as `google/<id>`). Unknown quality stays `null`; nothing is invented.

`OVERRIDES` records behaviour verified against the real APIs that catalogs don't describe (e.g. North Mini Code garbles output with reasoning disabled, so it is `always`). If a catalog can't be fetched, `server/catalog-snapshot.mjs` (same rules, captured 2026-10-04) is used for that provider and the fetch is retried after 5 minutes. Tests use the snapshot (`MODEL_REGISTRY_LIVE=false`).

## 2. Classification (`server/router/classify.mjs`)

Deterministic — no model call. Signals from the latest user message (attachments are recognised by their `<file>` blocks): task type (simple, rewrite, summarization, structured, general, creative, coding, debugging, reasoning, math, data-analysis, long-document, multimodal), difficulty points (base per type + hard keywords such as *architecture, race condition, prove* + length + numbered requirements + large code blocks), and the estimated prompt size. Short follow-ups ("and in Go?") inherit the previous task.

| Tier | Points | Typical requests |
|---|---|---|
| fast | ≤ 1 | greetings, short questions and instructions, rewrites, short summaries |
| general | 2–3 | normal conversation, creative writing, typical coding, explanations |
| advanced | ≥ 4 | complex debugging, proofs, architecture, multi-step analysis |

## 3. Filtering (`server/router/route.mjs`)

A model is excluded when it can't take the request: no streaming; no image input for an image request; max output below `min(requested, 4096)`; context window smaller than prompt + that output + margin. Models cooling down after failures are skipped while others remain (if all are cooling, they are tried anyway — no dead end).

## 4. Scoring

Internal ranking only — never shown as a benchmark. Each component is 0–1; weights depend on the tier:

| Component | Meaning | fast | general | advanced |
|---|---|---|---|---|
| fit | benchmark quality vs. need (coding index for coding/debugging, intelligence otherwise), normalized to the best eligible model. Need: 0.5 / 0.75 / 1.0 of the best. Below need is penalized ×2; above need is penalized ×0.8 / ×0.3 / ×0 — so easy tasks get a smaller model and hard tasks the strongest | 0.45 | 0.55 | 0.65 |
| reliability | success rate in the health window, (ok+1)/(n+2) | 0.15 | 0.15 | 0.15 |
| latency | measured time to first token vs. the fastest eligible model | 0.20 | 0.10 | 0.05 |
| cost | 1 for free, 1/(1 + $/M output) otherwise | 0.10 | 0.10 | 0.05 |
| budget | share of OpenRouter's free daily requests left (`GET /key`) | 0.10 | 0.10 | 0.10 |

Bonuses: +0.03 reasoning support for reasoning-heavy tasks, +0.02 when the model can write the full requested output, +0.05 for the previous answer's model on short follow-ups, and **+1 for Continue** (a continuation always stays on the model that wrote the answer, if it is eligible). Cost can't override capability: a model far below the need loses on `fit`. Ties break by registry order, so decisions are reproducible.

**Reasoning effort** follows the tier when thinking is on (fast → low, general → medium, advanced → high, mapped to the nearest level the model supports: Gemini `thinkingLevel`, OpenRouter `reasoning.effort`). With thinking off, a `toggle` model gets `off` (Gemini: its lowest level, `minimal`; OpenRouter: `reasoning.enabled: false`); an `always` model gets its lowest level.

## 5. Failover (`server/api.mjs`)

Candidates are tried in score order, at most `ROUTER_MAX_ATTEMPTS` (3) per request, never the same model twice. Each attempt has its own abort controller and a first-token timeout (`ROUTER_ATTEMPT_TIMEOUT_SECONDS`, 45 s when fallback is on); the request-wide queue limit (`UPSTREAM_QUEUE_TIMEOUT_SECONDS`) still applies.

- **Failover boundary — never mix two models in one reply.** Each attempt is in one of four states:

  | State | What reached the browser | If the model fails |
  |---|---|---|
  | A | nothing | the next candidate is tried silently |
  | B | reasoning only, no answer text | the next candidate is tried; first a `reset` event tells the browser to discard the attempt (reasoning, timing, usage) and show *"The model is busy. Trying another available model…"*; the next model then sends a fresh `start` |
  | C | answer text | no switch: the reply ends with an error (Retry/Continue) |
  | D | finished | — |

  Reasoning and answer text are told apart by the adapters (Gemini `part.thought`, OpenRouter `delta.reasoning` vs `delta.content`). The `reset` is sent only when another model actually starts; if none does (manual model without fallback, attempts used up), the failed model's reasoning stays with the error as before. A model that goes silent for 60 s during reasoning counts as failed (state B); silence after answer text ends the reply. Stop cancels the current attempt and no further model is started — also while backing off between attempts.
- Retried: 404/403 (model unavailable or restricted), 402 (needs credits), 429, 5xx/"high demand", timeouts, network errors, a stream that ends without a finish reason, and 400s (another model may accept the request, e.g. a context limit).
- **Provider coverage:** if every attempt so far failed on one provider, the last allowed attempt goes to the best candidate from another provider, so an outage of one provider (e.g. 503 on every Gemini model) can't use up all attempts.
- A rejected key or unreachable provider excludes **that provider** for the rest of the request; OpenRouter's account-wide free quota (`free-models-per-day`) excludes its **free models**.
- Backoff (300 ms × 2ⁿ, ≤ 2 s) only before retrying the same provider after an overload.
- If nothing works, the error says which models were tried and why.

## 6. Health (`server/router/health.mjs`)

In memory per server instance; model ids, outcomes and timings only. Rolling window of 15 minutes (≤ 30 events per model). A failure starts a cooldown that doubles with consecutive failures (overload 20 s → 10 min cap; timeout 30 s; rate limit 60 s → 15 min; unavailable 6 h; needs credits 30 min); a success ends it. Provider-wide cooldowns: rejected key 10 min, free quota 30 min, unreachable 30 s. Health checks that find a rejected key cool that provider down immediately. `/api/models` reports each model as `ok`, `degraded` or `cooling` (shown as **Busy** in the picker).

On serverless hosts each instance learns on its own and starts fresh after a cold start.

## 7. Manual mode

A chosen model is used as-is: no silent replacement. If it fails, the error offers **Retry**. The setting *Fall back if my chosen model fails* (`allowFallback`, off by default) lets the router continue with other models; the reply then says the chosen model was unavailable.

## 8. What users see

When a fallback model answered: the model that answered and a small provider chip with a "fallback" flag that expands to one sentence — which model was unavailable and which answered instead. *Show routing details* (Settings → Chat, developer view) adds the full decision:

```
Request
→ Task type: coding (general tier) · coding
→ Requirements: ~16 prompt tokens, 4,000 output, ranked by coding benchmark
→ Eligible models: gemini-3.6-flash (0.95), gemini-3.5-flash-lite (0.856), qwen/qwen3.8-27b:free (0.835), …
→ Attempts: gemini-3.6-flash ok 2528 ms
→ Selected provider: Gemini API
→ Selected model: Gemini 3.6 Flash
→ Reason: A coding task — chose Gemini 3.6 Flash because …
→ Fallbacks available: gemini-3.5-flash-lite, gemini-3.7-flash, qwen/qwen3.8-27b:free, …
```

No keys, message text or IP addresses are included.

## Adding a provider

1. Write `server/providers/<name>.mjs` exporting `{ id, label, vendor, keyEnv, configured(), check(modelId, signal), open({ model, messages, system, temperature, topP, maxTokens, effort, signal }) }`. `open` returns `{ maxTokens, events }` where `events` yields `reasoning`/`content`/`usage`/`error`/`finish`/`alive` events, and throws `UpstreamError(status, detail)` for provider failures.
2. Add its catalog to `registry.mjs` (a `buildModels` branch normalizing to the shared shape) and a snapshot entry.
3. Register it in `PROVIDERS` in `server/api.mjs`. The router, health tracking, failover and UI need no changes.

## Tests

`server/router.test.mjs` (classification, tiers on real snapshot data, filters, token limits, effort, health/recovery) and `server/routing.test.mjs` (end to end through `/api/chat` against a fake server playing both providers: outages, timeouts, rate limits, quota, failures before/after the first token, manual mode, max attempts, continuation, Stop).
