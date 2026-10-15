# Prometheus · AI Factory

_Formerly HiveMind. Chats and settings saved under the old browser storage key (`hivemind.v1.`) are copied to `prometheus.v1.` automatically on first load._

A public demo of a workspace-style AI chat app powered by the **Google Gemini API** and **OpenRouter**. It runs in Google AI Studio (Build), on Cloud Run, or on Vercel. Anyone with the link can use it — there is no sign-in. API keys stay server-side, and rate limits are the abuse protection.

## Architecture

```
Browser ──HTTPS──▶ server.ts (Express) ─┬─ React SPA (Vite middleware in dev, dist/ in production)
                                        └─ /api/{chat,career,models,health} → server/api.mjs ─┬─▶ Gemini API (server/providers/gemini.mjs, @google/genai)
                                                                          ├─▶ OpenRouter (server/providers/openrouter.mjs)
                                                                          └─▶ Postgres (optional: global rate-limit counters)
```

All API logic is in `server/`. `server.ts` is the entry point for local runs, Google AI Studio and Cloud Run; on Vercel the same handler runs as functions (`api/*.mjs`).

## Google AI Studio

1. In [AI Studio Build](https://aistudio.google.com/apps), click **+** in the prompt box → **Import from GitHub**, pick this repository and click **Import repository**.
2. AI Studio injects `GEMINI_API_KEY` server-side. To add the OpenRouter models, add `OPENROUTER_API_KEY` under Settings → **Secrets**. `metadata.json` declares the server-side Gemini capability.
3. The preview runs `npm run dev` (Express + Vite on port 3000). **Deploy** publishes to Cloud Run, which runs `npm run build` and `npm start`.

Optional secrets: `DEFAULT_MODEL`, `DATABASE_URL` (global rate limits), `RATE_LIMIT_*`, `MAX_CONCURRENT_STREAMS`, `MAX_OUTPUT_TOKENS`, `LOG_SALT` — see `.env.example`.

## Local development

```bash
npm install
cp .env.example .env      # set GEMINI_API_KEY and/or OPENROUTER_API_KEY
npm run dev               # http://localhost:3000
```

| Script | What it does |
|---|---|
| `npm run dev` | Express server with the API and Vite (hot reload) on :3000 |
| `npm run build` | Type-check, then build to `dist/` |
| `npm start` | Serve `dist/` and the API with production security headers |
| `npm run preview` | Build, then `npm start` |
| `npm test` | Server (incl. streaming against fake Gemini and OpenRouter APIs), token, theme-contrast, settings, markdown and math tests (`node --test`, no network) |

Without `DATABASE_URL`, rate limits live in process memory. To run the Postgres store test against a real database, set `POSTGRES_URL_FOR_TESTS`.

## Deploying to Vercel (optional)

`vercel.json` sets the build, function durations, request cancellation and security headers. In the project's environment variables set `GEMINI_API_KEY` and/or `OPENROUTER_API_KEY` (mark them **Sensitive**), optionally `OPENROUTER_API_KEY_BACKUP`, `OPENROUTER_API_KEY_BACKUP_2` (Sensitive), `DATABASE_URL` (global rate limits) and `DEFAULT_MODEL` (`auto` or a model id; an unknown value falls back to `auto`). Never use a `VITE_` prefix for keys. Then `vercel deploy --prod` and check `GET /api/health` (it reports the deployment that answered).

## Features

- **Career Guidance Factory**: four AI agents (Skills → Career → Learning → Job Matching) turn a user's skills, interests and goals into a personalized career and learning roadmap, streamed agent by agent, with course and job search links (no extra API keys). Roadmaps are saved like chats (search, rename, export Markdown) and can resume from a failed agent. See docs/API.md
- Streaming chat with stop, regenerate, retry, edit-and-resend, and **Continue** when a response hits the output or time limit
- **You choose the model** — the default is Gemini 3.6 Flash (`DEFAULT_MODEL` to change it). Automatic per-message model selection was removed (2026-10-15) because it kept landing on overloaded Gemini models. The opt-in setting *Fall back if my chosen model fails* (off by default) lets another available model answer when the chosen one is busy — never after answer text has started (docs/ROUTING.md)
- Model picker grouped by provider, discovered from the providers' live catalogs (currently 6 Gemini and 6 free OpenRouter models), with a *Busy* badge on models that recently failed; optional routing-details view for developers
- Visible thinking, thinking on/off where supported (effort scales with task difficulty), temperature, top-p, system prompt
- **Max output up to 300,000 tokens** (each model is limited to what its provider allows, e.g. 65,536 for Gemini), with presets
- Math (KaTeX) and syntax highlighting (20+ languages), lazy-loaded; Markdown tables, code copy/wrap
- Conversations stored in the browser: search, rename, export Markdown/JSON, delete, delete-all
- Text-file attachments (picker or drag-and-drop)
- Themes: **Dark**, **True Black**, **White + Gold** — persisted, applied before first paint
- Responsive (desktop, tablet drawer, phone), keyboard shortcuts, WCAG AA contrast, axe-clean

## Limits and behaviour

| | Value | Notes |
|---|---|---|
| Messages per visitor (IP) | 6 / minute, 120 / day | Global across instances only with `DATABASE_URL` |
| Messages for the whole demo | 1,500 / day | Protects the providers' quotas |
| Simultaneous responses per visitor | 2 | Slots are 30 s leases renewed while streaming |
| One response | ≤ 285 s on Cloud Run / Vercel, 10 min locally | Platform request timeout (300 s) − 15 s. Then "Paused at the time limit" + Continue |
| Output | ≤ 300,000 tokens | Lowered per model to what it supports (Gemini 65,536; the largest current free model ~236K) |
| Request body | ≤ 2 MB | |

## Known limitations

- **Public by link**: anyone with the URL spends the demo's quotas (bounded by the limits above and by the providers' own free-tier limits — a `429` is shown as "rate limit or daily quota reached").
- **OpenRouter free tier**: a key without credits allows **50 requests per day** across all `:free` models, and popular free models are sometimes rate-limited upstream. Adding $10 of credit raises the free-model limit to 1,000/day. Extra keys (`OPENROUTER_API_KEY_BACKUP`, `OPENROUTER_API_KEY_BACKUP_2`) are fallbacks, but keys on the same account share that limit.
- **Chats live in each browser** (`localStorage`); they don't sync and aren't on the server.
- **Attachments are text only** — no image/PDF/Office parsing. The router can route image requests to image-capable models, but there is no image upload yet, so that path is only covered by tests.
- A visitor's IP is the rate-limit identity: people behind one NAT share a quota; a visitor with many IPs gets more (the global daily cap still applies).
- Security headers are sent by `npm start` / Cloud Run and `vercel.json`, not by the dev server (React refresh needs inline scripts).
- **Router health is per server instance**: on Vercel each function instance learns model health on its own and starts fresh after a cold start or redeploy.
- **Fallback order isn't fixed** (only when fallback is on): measured latency and recent failures change the ranking of close candidates, so a busy chosen model may be replaced by different similar models over time.
- **Not every model is equally available**: free OpenRouter models are sometimes rate-limited upstream, and Gemini models report "high demand" at times; the chosen model then shows an error with Retry (or, with fallback on, another model answers).
- **Only free OpenRouter models are used by default.** Paid models (which cost money per request) are added only through `OPENROUTER_EXTRA_MODELS`; fallback ordering still prefers free models unless a paid one is clearly better. With fewer providers' models in the advanced tier, a request's last failover attempt is reserved for another provider when all earlier attempts failed on one.
- **Rate-limit failover** (a provider's 429) is covered by automated tests with a simulated provider; real provider outages, timeouts and rejected keys were verified against the live APIs.
