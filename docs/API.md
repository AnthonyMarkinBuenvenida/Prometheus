# API layer

`server/api.mjs` sits between the browser and the model providers. It holds the keys, rate-limits callers, validates input, plans the output-token budget, and maps upstream failures to user-readable errors. Provider adapters in `server/providers/` translate the request and normalize each provider's stream into the app's own events: `gemini.mjs` (Gemini API via `@google/genai`) and `openrouter.mjs` (OpenRouter's OpenAI-compatible API). Each throws `UpstreamError { status, detail }` for provider failures. The same handler runs inside `server.ts` (local, Google AI Studio, Cloud Run) and as Vercel functions (`api/chat.mjs`, `api/models.mjs`, `api/health.mjs`). All routes are public — there is no sign-in.

## Routes

### `GET /api/health`
`{ status: "ok" | "missing_key" | "auth_failed" | "unreachable", message, providers: { gemini?, openrouter? }, deployment }` — checks every provider that has a key (Gemini: `models.get`; OpenRouter: `GET /key`, which spends no quota), cached 60 s (`?fresh` bypasses the cache at most once per 5 s). `status` is the worst provider's. `auth_failed` means a provider rejected its key (Gemini reports a bad key as `400 API key not valid`, OpenRouter as `401`). `deployment` is the Cloud Run revision, the last 8 chars of the Vercel deployment id, or `local`.

### `GET /api/models`
```json
{ "defaultModel": "gemini-3.6-flash", "models": [{ "id", "label", "vendor", "provider", "description", "reasoning", "vision", "free", "maxOutput", "contextWindow", "status" }],
  "limits": { "outputCap": 300000, "streamSeconds": 285, "rateLimitScope": "global" } }
```
The registry's models whose provider has a key (all of them when no key is set), by provider and strongest benchmark first. `provider` is the display name (`"Gemini API"`, `"OpenRouter"`); `status` is the router's runtime health (`ok` / `degraded` / `cooling`). `defaultModel` is `DEFAULT_MODEL` when it names a listed model, else `gemini-3.6-flash`, else the first listed model — never `"auto"` (automatic selection was removed). `maxOutput` is what this deployment allows for the model: `min(MAX_OUTPUT_TOKENS, model output limit)`. `rateLimitScope` is `per-instance` when no database is configured.

### `POST /api/chat`
```json
{ "model": "gemini-3.6-flash", "messages": [{ "role": "user", "content": "…" }],
  "system": "optional, ≤ 8000 chars", "temperature": 0.6, "topP": 0.95, "maxTokens": 50000, "thinking": true }
```
Validation failures return `{ error: { message, code } }` before streaming. Limits: 200 messages, 600k chars, 2 MB body; the last message must be a non-empty user turn.

On success: `text/event-stream`, one JSON object per `data:` frame:

| Event | Payload |
|---|---|
| `start` | `{ model, maxTokens, limitSeconds, route, debug? }` — `model` is the model that answers (the chosen one, or a fallback when `allowFallback` is on); `maxTokens` is what was actually sent (may be below the request); `route` = `{ mode, provider, model, task, reason, fallbackFrom }`; `debug` (only when the request has `debug: true`) = the full routing decision |
| `reset` | `{ message, code }` — the model failed after streaming only reasoning; discard everything received since the last `start` and show `message` until the next `start` (another model). Never sent after answer text |
| `reasoning` | `{ text }` — reasoning delta (Gemini: thought-summary parts, `thought: true`; OpenRouter: `delta.reasoning`) |
| `content` | `{ text }` — answer delta |
| `usage` | `{ usage: { prompt, completion, reasoning } }` — `completion` = answer + thinking tokens |
| `done` | `{ finishReason }` — `"stop"`, `"length"` (Gemini `STOP`/`MAX_TOKENS` are mapped), others as sent. A Gemini safety/recitation stop also sends an `error` with code `blocked` |
| `error` | `{ message, code }` — mid-stream failure; the stream then ends |

**Request mapping**
- Model: the chosen id is used as-is. No model — or `"auto"`, sent by pages loaded before automatic selection was removed — means the default model. With `allowFallback: true` the router (docs/ROUTING.md) ranks other models to try if the chosen one fails; `continuation` and `previousModel` are accepted for that ranking. The reasoning effort comes from the task's difficulty and the `thinking` flag.
- Gemini: `assistant` → role `model` (empty turns dropped), `system` → `systemInstruction`, `temperature`/`topP` clamped, `maxOutputTokens` planned as below, `thinkingConfig.includeThoughts: true` plus `thinkingLevel` from the effort (thinking off = the model's lowest level: `minimal` where supported, else `low`).
- OpenRouter: OpenAI chat format (`system` first), `max_tokens`, `stream: true`, `X-Title: Prometheus`. Keys: `OPENROUTER_API_KEY`, then `OPENROUTER_API_KEY_BACKUP`, then `OPENROUTER_API_KEY_BACKUP_2` (a model may name its own first key with `keyEnv` in the registry overrides; none does by default). A key-specific failure (401, 402, a key/disabled 403, a 429 that isn't "rate-limited upstream") retries the request with the next key and benches the failed key (tried last) for 5 minutes. Health checks every key with `GET /key` and stays `ok` while any works, naming rejected keys in `message`. Effort is sent as `reasoning: { effort }` (verified on Qwen 3.8); thinking off on a `"toggle"` model sends `reasoning: { enabled: false }` (verified to remove reasoning on Nemotron 3 Super/Ultra and Qwen 3.8; it garbled North Mini Code's answer, so that model is `"always"`). `: OPENROUTER PROCESSING` comment lines keep the idle timer alive; a `{ error }` chunk or `finish_reason: "error"` ends the stream with an error.

**Output tokens** (`server/tokens.mjs`): the requested value is clamped to `[256, min(300 000, model.maxOutput)]` and to the context left after the prompt (estimated at 3 chars/token + 256 margin). Gemini only: one recoverable `400` is retried once: an output ceiling in the error message ("supported range is from 1 (inclusive) to N (exclusive)") lowers `maxOutputTokens`; an error mentioning thinking drops `thinkingLevel`.

**Timing**: a provider may take up to `UPSTREAM_QUEUE_TIMEOUT_SECONDS` (default 120, capped 30 s below the stream limit) to start before a 504 `upstream_timeout`; 60 s of mid-stream silence → `idle_timeout`; at the stream limit the stream is ended cleanly with `max_duration` (the UI shows "Paused at the time limit" + Continue). On Cloud Run (`K_SERVICE`) and Vercel the stream limit is `FUNCTION_MAX_DURATION` (300 = Cloud Run's default request timeout and `vercel.json` maxDuration) − 15 s = **285 s**; locally 10 minutes.

**Cancellation**: when the client disconnects (Stop, closed tab) the upstream request is aborted so the provider stops generating. On Vercel this requires `supportsCancellation: true` on the function.

### `POST /api/career`
The **Career Guidance Factory** (`server/career.mjs`): four agents run one after another in one stream — Skills Agent (evaluates the user's skills), Career Agent (recommends careers), Learning Agent (phased learning roadmap with courses), Job Matching Agent (suitable roles, where to look). Each agent is one model call with its own system prompt; its user message holds the profile and every earlier agent's output.

Request: `{ model, profile: { skills, interests, education, goals, location }, temperature, topP, thinking, allowFallback?, from?, previous? }`. `skills` is required (≤ 3,000 chars; the others ≤ 2,000 / 1,000 / 2,000 / 120). `from` (0–3) resumes at that agent; `previous` must then hold the earlier agents' results (`{ skills, career, … }`, ≤ 40,000 chars each). Validation errors are 400 `invalid_request` before any model call.

Each agent goes through the same attempt loop as chat (`runAttempts` in `server/api.mjs`): the chosen model first, fallback only with `allowFallback`, the same A–D states, timers and health. Reasoning effort is fixed per agent (low for Skills and Job Matching, medium for Career and Learning). The whole run shares one stream limit (285 s on Vercel/Cloud Run) and counts as **one message** for rate limiting (one `acquireChat`).

Events are the chat events with an `agent` field (`skills` | `career` | `learning` | `jobs`), plus `{ type: "agent-done", agent, finishReason }` after each agent and `{ type: "done" }` after the last. A failed agent ends the run with `{ type: "error", agent, message, code }` (`empty_response` if it produced no text); the browser offers to resume from that agent. If the first agent fails before anything streamed, the response is a JSON error, as in chat.

The agents never write URLs. The Learning and Job Matching agents end with a fenced `json` block (`{"courses": […]}` / `{"jobs": […]}`); the browser hides it and turns each name into search links (Coursera, edX, YouTube; LinkedIn, Indeed, Google with the user's location) in `src/lib/career.ts`.

### Error codes
`forbidden_origin` 403 · `not_found` 404 · `method_not_allowed` 405 · `unsupported_media_type` 415 · `missing_key` 503 · `invalid_json` / `invalid_request` / `invalid_model` 400 · `too_large` / `too_long` 413 · `rate_limited` / `too_many_streams` 429 (with `Retry-After`) · `auth_failed` / `model_unavailable` / `upstream_error` / `upstream_unreachable` 502 · `invalid_model` 400 also for a manual model that is no longer available · `payment_required` 402 (OpenRouter needs credits) · `upstream_busy` 503 ("high demand") · `upstream_timeout` 504 · in-stream: `idle_timeout`, `max_duration`, `blocked`, `upstream_error` (the provider failed mid-stream; Gemini's SDK drops the error event, so any stream that ends without a finish reason is reported as this). Unexpected failures return 500 `server_error` with a generic message; details go to the function log only. Unknown `/api/*` paths on Vercel get the platform's 404.

## Rate limiting (`server/limits.mjs`)

Applied to `POST /api/chat` and `POST /api/career` (one whole career run = one message) **before the body is read** (invalid requests count too), keyed by client IP:

| Limit | Default | Env |
|---|---|---|
| Per IP per minute | 6 | `RATE_LIMIT_CHAT_PER_MIN` |
| Per IP per day | 120 | `RATE_LIMIT_CHAT_PER_DAY` |
| Whole demo per day | 1,500 | `RATE_LIMIT_GLOBAL_PER_DAY` |
| Concurrent responses per IP | 2 | `MAX_CONCURRENT_STREAMS` |

Storage: with `DATABASE_URL`/`POSTGRES_URL`, counters live in the `prometheus_limits` table (created on first use; Neon serverless driver over HTTP) and are **global across instances** (Cloud Run, Vercel). Without it — or if the database errors — limits fall back to per-process memory (logged as `[limits] database unavailable`). Windows are fixed (count + expiry per key). Each concurrency slot is its own row holding a 30 s lease, renewed every 10 s while the response streams and deleted when it ends. A request that is cancelled or frozen can't run that cleanup (observed on Vercel), so its slot simply expires within 30 s.

Client IP: on Vercel (`VERCEL=1`) from `x-real-ip` / `x-forwarded-for`, which Vercel sets itself — verified that spoofed values don't change the identity. On Cloud Run (`K_SERVICE`) the **last** `x-forwarded-for` entry, which Google's front end appends (not yet verified against a live deployment). Elsewhere the socket address is used and forwarding headers are ignored.

## Security model

| Concern | Mechanism |
|---|---|
| Access | Public by design. Anyone with the URL can chat; limits bound the cost. |
| Secrets | `GEMINI_API_KEY`, the `OPENROUTER_*` keys and the database URL are read only in `server/` (AI Studio Secrets, or Cloud Run / Vercel env vars). Never sent to the browser. |
| Quota abuse | Per-IP minute/day windows, a global daily cap and per-IP concurrency, enforced globally via Postgres. |
| Cross-site use | Non-GET requests need a same-origin `Origin` (or none) and a JSON body (`415` otherwise); no CORS headers are sent, so other sites' scripts can't call the API. |
| Input | Body ≤ 2 MB, ≤ 200 messages / 600k chars, system prompt ≤ 8k, numeric params clamped, model must be in the allowlist. |
| Logs | `METHOD /path status duration client=<hash>` — no headers, bodies, query strings, keys or raw IPs. |
| Browser hardening | `server/securityHeaders.mjs` (sent by `npm start` and `vercel.json`): CSP `default-src 'self'` (scripts `'self'` only; `style-src 'unsafe-inline'` is needed by KaTeX), `frame-ancestors 'self' https://aistudio.google.com` (AI Studio shows the app in an iframe, so no `X-Frame-Options`), `nosniff`, `Referrer-Policy: no-referrer`, COOP, Permissions-Policy. |
| Untrusted model output | No raw HTML rendering, default URL sanitizing (no `javascript:`), KaTeX `trust:false` + `maxExpand`, highlighting via element trees (no `innerHTML`). |

Tests: `server/api.test.mjs`.

## Models and routing

Models aren't a fixed list: `server/registry.mjs` discovers them from the providers' live catalogs. There is no automatic model selection; `server/router/` sets the thinking effort and, only when the user enables fallback, ranks other models to try, with health tracking. See **docs/ROUTING.md**.
