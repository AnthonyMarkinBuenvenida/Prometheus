# Prometheus — project instructions

(Formerly HiveMind. Browser storage is `prometheus.v1.`; `src/lib/storage.ts` and `public/theme-init.js` still read the legacy `hivemind.v1.` keys so existing users keep their chats — don't remove that fallback. Rate-limit table: `prometheus_limits`.)

Public demo for Google AI Studio (Build) / Cloud Run, also deployable on Vercel. React 19 + Vite 8 + TypeScript SPA; plain-ESM API in `server/` served by `server.ts` (Express + Vite middleware, port 3000) and as Vercel functions (`api/*.mjs`); two model providers behind one stream format — Gemini API (`server/providers/gemini.mjs`, `@google/genai`) and OpenRouter (`server/providers/openrouter.mjs`); optional Postgres for global rate-limit counters. No authentication by design. Setup/deploy: README.md.

## Commands
- `npm run dev` — app + API on :3000 (`tsx server.ts`; also what AI Studio runs)
- `npm start` — production server (`dist/` + API + security headers)
- `npm test` — must pass (no network). Set `POSTGRES_URL_FOR_TESTS` to include the real-database store tests.
- `npm run build` — must pass before calling work done
- AI Studio imports this repo from GitHub (Build → + → Import from GitHub) and injects `GEMINI_API_KEY` (`OPENROUTER_API_KEY` goes in its Secrets); keep `metadata.json` and the `dev`/`start` scripts.

## Rules
- Secrets (`GEMINI_API_KEY`, `OPENROUTER_API_KEY` (+ `_BACKUP`, `_BACKUP_2`), `DATABASE_URL`) are read only in `server/`. Never `VITE_`-prefix them or reference `import.meta.env` secrets in `src/`. Never log headers, bodies, query strings or raw IPs (use `logId`).
- There is no sign-in: rate limits (`server/limits.mjs`) are the abuse protection. Every model-calling route must go through `acquireChat`. Don't claim memory-only limits are global.
- Serverless runtime facts (verified on Vercel; assume the same on Cloud Run): work after the response ends may never run, and a cancelled request's function can stop before async cleanup — release resources before `res.end()` and rely on short leases (concurrency slots) rather than cleanup.
- Keep `vercel.json` in sync: security headers = `server/securityHeaders.mjs` (framing allowed only for aistudio.google.com); `api/chat.mjs` maxDuration = `FUNCTION_MAX_DURATION` default (300); `supportsCancellation: true` (without it Stop doesn't reach the function). Tests enforce the first two.
- Models come from `server/registry.mjs` (discovery rules over live provider catalogs; `catalog-snapshot.mjs` is the fallback — regenerate it, don't hand-edit). There is no automatic model selection (removed 2026-10-15 at the user's request: it kept landing on overloaded Gemini models) — don't reintroduce it unless asked. The default model is `DEFAULT_MODEL`, else `gemini-3.6-flash`. `server/router/` (classify → filter → score; docs/ROUTING.md) only sets thinking effort and ranks fallback models when the user turns on *Fall back if my chosen model fails*. Don't hard-code a "best" model or invent quality scores: quality is the Artificial Analysis data from OpenRouter's catalog, `null` when unknown. Failover only before answer text reaches the browser: after reasoning-only output the server sends `reset` and the client discards the attempt; never mix two models in one reply (server/failover.test.mjs). Verify routing changes with real requests (the OpenRouter account allows only 50 free requests/day). Router tests: `server/router.test.mjs`, `server/routing.test.mjs`. Output is capped at `MAX_OUTPUT_TOKENS` (300,000) and clamped per request (`server/tokens.mjs`).
- Model output is untrusted: no `rehype-raw`, no `innerHTML`, KaTeX `trust: false`. Markdown goes through `normalizeMath` + `splitBlocks` (keep their tests green).
- Colors only via tokens in `src/styles/tokens.css`; every theme must define every token and pass `src/styles/tokens.test.ts` (contrast). No ad-hoc z-index (docs/DESIGN.md "Layering").
- Components that only act use stable contexts (`useConversationActions`, `useDraftActions`). Don't subscribe to per-keystroke or per-frame state without need.
- Frontend changes need browser verification at 1440, 768 and 390 widths; deployment changes need verification on the live URL.

## Docs
- docs/DESIGN.md — tokens, themes, layering, breakpoints, component and rendering conventions
- docs/API.md — routes, SSE events, provider request mapping, limits, security model
- docs/ROUTING.md — registry, classifier, scoring, failover, health, manual mode, adding a provider
