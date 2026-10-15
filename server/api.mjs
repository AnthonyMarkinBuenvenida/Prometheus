// Server-side API layer — the only code that sees the provider keys (GEMINI_API_KEY, OPENROUTER_*).
// Runs inside server.ts (Express: local dev, Google AI Studio, Cloud Run) and as Vercel
// functions (api/*.mjs). Prometheus is a public demo: there is no sign-in; abuse protection is
// rate limiting (server/limits.mjs), request limits and validation.
//
//   registry.mjs        which models exist (live provider catalogs, normalized)
//   router/             task classification, scoring, health tracking (docs/ROUTING.md)
//   providers/          one adapter per provider (request format, stream parsing)
//
// Routes:
//   GET  /api/health  -> { status: "ok" | "missing_key" | "auth_failed" | "unreachable", message, providers } (?fresh: at most every 5s)
//   GET  /api/models  -> { models, defaultModel, limits }
//   POST /api/chat    -> text/event-stream of normalized events (see docs/API.md)

import { waitUntil } from "@vercel/functions";
import { clientIp, isSameOrigin, logId } from "./http.mjs";
import { acquireChat, LimitError, limitScope } from "./limits.mjs";
import { geminiProvider } from "./providers/gemini.mjs";
import { openrouterProvider } from "./providers/openrouter.mjs";
import { UpstreamError } from "./providers/upstream.mjs";
import { getRegistry } from "./registry.mjs";
import * as health from "./router/health.mjs";
import { effortFor, MAX_ATTEMPTS, plan, reasonFor } from "./router/route.mjs";
import { modelOutputLimit, outputCap, planMaxTokens } from "./tokens.mjs";

/** Model id sent by pages from before automatic selection was removed; treated as "the default model". */
export const AUTO = "auto";
const PROVIDERS = { gemini: geminiProvider, openrouter: openrouterProvider };

// How long a request may wait for its first token in total (OpenRouter's free models can queue).
// Always capped below the stream limit so a slow start can still produce an answer.
function headersTimeoutMs() {
  const s = Number(process.env.UPSTREAM_QUEUE_TIMEOUT_SECONDS);
  const wanted = Number.isFinite(s) && s > 0 ? s * 1000 : 120_000;
  return Math.min(wanted, streamLimitMs() - 30_000);
}
// In Auto mode one model gets this long to start before the router tries the next one.
function attemptTimeoutMs() {
  const s = Number(process.env.ROUTER_ATTEMPT_TIMEOUT_SECONDS);
  return Number.isFinite(s) && s > 0 ? s * 1000 : 45_000;
}
const IDLE_TIMEOUT_MS = 60_000; // max silence between streamed chunks
const HEALTH_TTL_MS = 60_000;
const HEALTH_FRESH_MIN_MS = 5_000; // "Re-check" can't be used to hammer the providers
const MAX_BODY_BYTES = 2_000_000;
const MAX_MESSAGES = 200;
const MAX_TOTAL_CHARS = 600_000;
const MAX_SYSTEM_CHARS = 8_000;

/**
 * Longest a single response may stream. On Vercel and Cloud Run the platform ends a request at
 * its timeout (FUNCTION_MAX_DURATION, seconds; 300 = vercel.json maxDuration and Cloud Run's
 * default), so the stream ends cleanly a little before that with a "time limit" event the UI
 * can offer to continue from.
 */
export function streamLimitMs() {
  const explicit = Number(process.env.STREAM_LIMIT_SECONDS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit * 1000;
  if (process.env.VERCEL === "1" || process.env.K_SERVICE) return (Number(process.env.FUNCTION_MAX_DURATION) || 300) * 1000 - 15_000;
  return 10 * 60_000;
}

class HttpError extends Error {
  constructor(status, message, code, headers) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** Registry models whose provider has a key; every model when none is configured (health then reports missing_key). */
async function availableModels() {
  const { models } = await getRegistry();
  const ready = models.filter((m) => PROVIDERS[m.provider]?.configured());
  return ready.length ? ready : models;
}

// Used when DEFAULT_MODEL isn't set (or names a model that isn't available). Gemini 3.6 Flash was the
// most dependable mid-size model in production testing (2026-10).
const PREFERRED_DEFAULT = "gemini-3.6-flash";

/** The model used when a request names none: DEFAULT_MODEL, else PREFERRED_DEFAULT, else the first listed. */
function defaultModelId(models) {
  const configured = process.env.DEFAULT_MODEL;
  if (configured && models.some((m) => m.id === configured)) return configured;
  return models.some((m) => m.id === PREFERRED_DEFAULT) ? PREFERRED_DEFAULT : models[0]?.id;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function retryAfterHeader(ms) {
  return { "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))) };
}

function writeEvent(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
    throw new HttpError(415, "Requests must be sent as JSON.", "unsupported_media_type");
  }
  const tooLarge = () => new HttpError(413, "Request is too large. Remove some attachments or start a new chat.", "too_large");
  if (Number(req.headers["content-length"]) > maxBytes) throw tooLarge();
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.", "invalid_json");
  }
}

function clamp(value, min, max, fallback) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function validateMessages(input) {
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, "No messages to send.", "invalid_request");
  if (input.length > MAX_MESSAGES) throw new HttpError(400, `Conversation exceeds ${MAX_MESSAGES} messages. Start a new chat.`, "too_long");
  let total = 0;
  const messages = input.map((m) => {
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") {
      throw new HttpError(400, "Each message needs a role of user or assistant and text content.", "invalid_request");
    }
    total += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (total > MAX_TOTAL_CHARS) throw new HttpError(413, "Conversation is too long for a single request. Start a new chat.", "too_long");
  const last = messages[messages.length - 1];
  if (last.role !== "user" || !last.content.trim()) throw new HttpError(400, "The last message must be a non-empty user message.", "invalid_request");
  return messages;
}

function isAuthError({ status, detail }) {
  // Gemini answers an invalid key with 400 INVALID_ARGUMENT "API key not valid", OpenRouter with 401.
  return status === 401 || ((status === 400 || status === 403) && /api[ _-]?key|unauthori[sz]ed|permission/i.test(detail));
}

function midStreamMessage(provider) {
  return `${provider.label} stopped partway through, usually because the model is busy. Try regenerating or pick another model.`;
}

/** UpstreamError (or anything else thrown while talking to a provider) -> user-readable HttpError. */
function mapUpstreamError(err, provider) {
  if (err?.attemptTimeout) return new HttpError(504, "The model didn't start responding in time. It's busy right now; try again or pick another model.", "upstream_timeout");
  if (!(err instanceof UpstreamError)) return new HttpError(502, `Could not reach ${provider.label}. Try again shortly.`, "upstream_unreachable");
  const { status, detail } = err;
  if (err.kind === "midstream") return new HttpError(502, midStreamMessage(provider), "upstream_error");
  if (isAuthError(err)) return new HttpError(502, `${provider.vendor} rejected the server's API key. The site owner needs to check ${provider.keyEnv}.`, "auth_failed");
  if (status === 402) return new HttpError(402, `${provider.label} needs credits for this request. Pick another model.`, "payment_required");
  if (status === 404) return new HttpError(502, `This model isn't available on ${provider.label} right now. Pick another model.`, "model_unavailable");
  if (status === 429) return new HttpError(429, `${provider.label}'s rate limit or daily quota was reached${detail ? ` (${detail})` : ""}. Wait a moment or pick another model.`, "rate_limited");
  if (status >= 400 && status < 500) return new HttpError(400, `The model rejected the request${detail ? `: ${detail}` : "."}`, "invalid_request");
  if (status === 503) return new HttpError(503, `${provider.label} is under high demand right now. Try again in a moment or pick another model.`, "upstream_busy");
  return new HttpError(502, `${provider.label} returned an error (${status}). Try again shortly.`, "upstream_error");
}

/**
 * How a failed attempt affects health and whether another model may be tried.
 * @returns {{ kind: string, provider?: { kind: string, scope?: string }, retryable: boolean }}
 */
function failureKind(err) {
  if (err?.attemptTimeout) return { kind: "timeout", retryable: true };
  if (!(err instanceof UpstreamError)) return { kind: "overloaded", provider: { kind: "unreachable" }, retryable: true };
  const { status, detail } = err;
  if (err.kind === "midstream") return { kind: "overloaded", retryable: true };
  if (isAuthError(err)) return { kind: "rejected", provider: { kind: "auth" }, retryable: true };
  if (status === 402) return { kind: "payment", retryable: true };
  if (status === 404 || status === 403) return { kind: "unavailable", retryable: true };
  if (status === 429) {
    // OpenRouter's account-wide free quota: every free model there would fail the same way.
    if (/free-models-per-day|per-day|daily/i.test(detail)) return { kind: "rate_limited", provider: { kind: "quota", scope: "free" }, retryable: true };
    return { kind: "rate_limited", retryable: true };
  }
  if (status >= 400 && status < 500) return { kind: "rejected", retryable: true }; // e.g. context limit: another model may fit
  return { kind: "overloaded", retryable: true };
}

let healthCache = null;

const HEALTH_RANK = { ok: 0, unreachable: 1, auth_failed: 2 };

async function checkProvider(provider, models) {
  const model = models.find((m) => m.provider === provider.id);
  try {
    const result = await provider.check(model?.id, AbortSignal.timeout(10_000));
    health.recordProviderSuccess(provider.id);
    return { status: "ok", message: `Connected to ${provider.label}.`, warnings: result?.warnings ?? [] };
  } catch (err) {
    if (err instanceof UpstreamError && isAuthError(err)) {
      health.recordProviderFailure(provider.id, "auth"); // Auto skips it right away
      return { status: "auth_failed", message: `${provider.vendor} rejected ${provider.keyEnv}.` };
    }
    if (err instanceof UpstreamError && err.status) return { status: "unreachable", message: `${provider.label} responded with ${err.status}.` };
    return { status: "unreachable", message: `Could not reach ${provider.label}.` };
  }
}

async function healthRoute(res, fresh) {
  const configured = Object.values(PROVIDERS).filter((p) => p.configured());
  if (!configured.length) {
    const keys = Object.values(PROVIDERS).map((p) => p.keyEnv).join(" or ");
    return sendJson(res, 200, { status: "missing_key", message: `No API key is set on the server (${keys}).`, providers: {} });
  }
  const age = healthCache ? Date.now() - healthCache.at : Infinity;
  if (age < (fresh ? HEALTH_FRESH_MIN_MS : HEALTH_TTL_MS)) return sendJson(res, 200, healthCache.body);

  const models = await availableModels();
  const results = await Promise.all(configured.map(async (p) => [p, await checkProvider(p, models)]));
  // The app works while any provider does (Auto routes around the others), so one failing provider
  // is a warning, not an outage; only when every provider fails is the worst status reported.
  const working = results.filter(([, r]) => r.status === "ok");
  const failing = results.filter(([, r]) => r.status !== "ok");
  const worst = results.reduce((a, b) => (HEALTH_RANK[b[1].status] > HEALTH_RANK[a[1].status] ? b : a));
  const status = working.length ? "ok" : worst[1].status;
  const warnings = [...failing.map(([, r]) => r.message), ...results.flatMap(([, r]) => r.warnings ?? [])];
  const message = [working.length ? `Connected to ${working.map(([p]) => p.label).join(" and ")}.` : "", ...warnings].filter(Boolean).join(" ");
  // Which deployment answered (non-secret; helps verify rollouts).
  const deployment = process.env.VERCEL_DEPLOYMENT_ID?.slice(-8) ?? process.env.K_REVISION ?? "local";
  const body = { status, message, providers: Object.fromEntries(results.map(([p, r]) => [p.id, r.status])), deployment };
  healthCache = { at: Date.now(), body };
  sendJson(res, 200, body);
}

async function modelsRoute(res) {
  const list = await availableModels();
  // UI order: provider, then strongest benchmark first (unknown last).
  const sorted = [...list].sort((a, b) => a.provider.localeCompare(b.provider) || (b.quality?.intelligence ?? -1) - (a.quality?.intelligence ?? -1));
  sendJson(res, 200, {
    defaultModel: defaultModelId(list),
    models: sorted.map((m) => ({
      id: m.id,
      label: m.label,
      vendor: m.vendor,
      provider: PROVIDERS[m.provider].label,
      description: m.description,
      reasoning: m.reasoning,
      vision: m.vision,
      free: m.free,
      contextWindow: m.contextWindow,
      maxOutput: modelOutputLimit(m),
      status: health.status(m),
    })),
    limits: { outputCap: outputCap(), streamSeconds: Math.floor(streamLimitMs() / 1000), rateLimitScope: limitScope() },
  });
}

async function chat(req, res) {
  if (!Object.values(PROVIDERS).some((p) => p.configured())) throw new HttpError(503, "The server has no API key configured.", "missing_key");

  let release;
  try {
    release = await acquireChat(clientIp(req));
  } catch (err) {
    if (err instanceof LimitError) throw new HttpError(429, err.message, err.code, retryAfterHeader(err.retryAfterMs));
    throw err;
  }
  // On a client disconnect (Stop, closed tab) try to free the slot immediately. The platform may
  // still end the request before this completes (observed on Vercel); the slot's short lease covers that.
  res.on("close", () => {
    if (!res.writableFinished) waitUntil(release());
  });
  try {
    await streamCompletion(req, res, release);
  } finally {
    await release(); // idempotent; covers errors thrown before streaming started
  }
}

/** First non-keep-alive event of a reply, or null if it ended without any. */
async function firstEvent(iterator, onAlive) {
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) return null;
    if (value.type !== "alive") return value;
    onAlive();
  }
}

async function streamCompletion(req, res, release) {
  const body = await readJson(req);
  const messages = validateMessages(body.messages);
  const system = typeof body.system === "string" ? body.system.trim().slice(0, MAX_SYSTEM_CHARS) : "";
  const promptChars = system.length + messages.reduce((n, m) => n + m.content.length, 0);
  const models = await availableModels();
  // There is no automatic model selection (removed 2026-10-15: it kept landing on overloaded Gemini
  // models). No model, or "auto" from a page loaded before that change, means the default model.
  const requested = !body.model || body.model === AUTO ? defaultModelId(models) : body.model;
  const manualFallback = body.allowFallback === true;

  // ----- Decide which models to try -----
  const budget = {};
  if (openrouterProvider.configured() && manualFallback) budget.openrouter = await openrouterProvider.budget();
  const routeReq = { messages, system, maxTokens: body.maxTokens, thinking: body.thinking, continuation: body.continuation === true, previousModel: typeof body.previousModel === "string" ? body.previousModel : undefined };
  const decision = plan(routeReq, models, { budget });
  // The chosen model first; with "fall back" on, the router's ranking supplies the other models to try.
  const chosen = models.find((m) => m.id === requested);
  if (!chosen) throw new HttpError(400, "That model is no longer available. Pick another model.", "invalid_model");
  const entry = decision.candidates.find((c) => c.model.id === chosen.id) ?? { model: chosen, score: null, parts: {}, bonus: [] };
  const order = [entry, ...(manualFallback ? decision.candidates.filter((c) => c.model.id !== chosen.id) : [])];

  // ----- Timers shared by all attempts -----
  const limitMs = streamLimitMs();
  let current = null; // AbortController of the attempt in progress
  let abortCause = null; // "client" | "max_duration" | "idle_timeout" (request-wide)
  let finished = false;
  const abortAll = (cause) => {
    if (!abortCause) abortCause = cause;
    current?.abort();
  };
  res.on("close", () => {
    if (!finished) abortAll("client");
  });
  const maxTimer = setTimeout(() => abortAll("max_duration"), limitMs);
  const deadline = Date.now() + headersTimeoutMs();

  // ----- Try candidates; stream the first that works -----
  // Per attempt, what has reached the browser decides whether another model may take over:
  //   A  nothing yet            → fall back silently
  //   B  reasoning only         → fall back: a "reset" event (sent only when another model actually
  //                                starts) makes the browser discard the attempt
  //   C  answer text started    → no fallback: an error ends the reply (never mix two models' answers)
  //   D  finished               → done
  const attempts = [];
  const maxAttempts = manualFallback ? MAX_ATTEMPTS() : 1;
  const excludedProviders = new Set(); // provider-wide failures (bad key, unreachable)
  const excludedFree = new Set(); // providers whose shared free quota ran out
  const streamEnd = Date.now() + limitMs - 15_000; // latest time a fallback attempt may still start
  let headersSent = false;
  let pendingReset = null; // set when a model failed after reasoning; sent when the next attempt starts
  let lastErr = null;
  const label = (id) => models.find((m) => m.id === id)?.label ?? id;
  const sendHeaders = () => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  };

  const tried = new Set();
  /**
   * Next candidate in score order. If every attempt so far failed on one provider, the last allowed
   * attempt goes to the best candidate from another provider, so an outage of one provider can't
   * use up all attempts (e.g. 503 on every Gemini model while OpenRouter works).
   */
  const nextCandidate = () => {
    const usable = order.filter((e) => !tried.has(e.model.id) && !excludedProviders.has(e.model.provider) && !(e.model.free && excludedFree.has(e.model.provider)));
    const failed = new Set(attempts.filter((a) => !a.ok).map((a) => a.provider));
    if (attempts.length && attempts.length === maxAttempts - 1 && failed.size === 1) {
      const other = usable.find((e) => !failed.has(e.model.provider));
      if (other) return other;
    }
    return usable[0];
  };

  try {
    for (;;) {
      if (attempts.length >= maxAttempts || abortCause) break;
      const entry = nextCandidate();
      if (!entry) break;
      tried.add(entry.model.id);
      const model = entry.model;
      const provider = PROVIDERS[model.provider];
      const remaining = (headersSent ? streamEnd : deadline) - Date.now();
      if (remaining <= 1000) break;
      // Back off before retrying the same provider after a provider-side failure.
      const prev = attempts.at(-1);
      if (prev && prev.provider === model.provider && prev.kind === "overloaded") {
        await new Promise((r) => setTimeout(r, Math.min(2000, 300 * 2 ** (attempts.length - 1))));
        if (abortCause) break; // Stop pressed while waiting: never start another model
      }

      const maxTokens = planMaxTokens(model, body.maxTokens, promptChars);
      if (maxTokens < 256) {
        attempts.push({ model: model.id, provider: model.provider, ok: false, error: "context too small", kind: "rejected", ms: 0 });
        continue;
      }
      const ctrl = new AbortController();
      current = ctrl;
      const started = Date.now();
      let attemptAbort = null; // "timeout" (no first event in time) | "idle" (silence mid-stream)
      let timer;
      const arm = (ms, cause) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          attemptAbort = cause;
          ctrl.abort();
        }, ms);
      };
      arm(manualFallback ? Math.min(attemptTimeoutMs(), remaining) : remaining, "timeout");
      const record = { model: model.id, provider: model.provider, ok: false, ms: 0 };
      attempts.push(record);
      let phase = "A";
      let finishReason = null;
      if (pendingReset) {
        writeEvent(res, pendingReset);
        pendingReset = null;
      }
      try {
        const reply = await provider.open({
          model,
          messages,
          system,
          temperature: clamp(body.temperature, 0, 2, 0.6),
          topP: clamp(body.topP, 0.01, 1, 0.95),
          maxTokens,
          effort: effortFor(model, decision.task.tier, body.thinking),
          signal: ctrl.signal,
        });
        const iterator = reply.events[Symbol.asyncIterator]();
        const first = await firstEvent(iterator, () => arm(IDLE_TIMEOUT_MS, "idle"));
        health.recordSuccess(model.id, { ttftMs: Date.now() - started });
        record.ok = true;
        record.ms = Date.now() - started;

        const fallbackFrom = attempts.filter((a) => !a.ok).map((a) => label(a.model));
        const route = {
          mode: "manual",
          provider: provider.label,
          model: model.label,
          task: decision.task.type,
          reason: reasonFor(decision, entry, { fallbackFrom, manual: true }),
          fallbackFrom,
        };
        sendHeaders();
        const start = { type: "start", model: model.id, maxTokens: reply.maxTokens, limitSeconds: Math.floor(limitMs / 1000), route };
        if (body.debug === true) start.debug = debugInfo(decision, entry, attempts, order);
        writeEvent(res, start);

        const handle = (event) => {
          if (event.type === "finish") finishReason = event.reason;
          else if (event.type !== "alive") {
            if (event.type === "content") phase = "C";
            else if (event.type === "reasoning" && phase === "A") phase = "B";
            writeEvent(res, event);
          }
        };
        arm(IDLE_TIMEOUT_MS, "idle");
        if (first) handle(first);
        for (;;) {
          const { value, done } = await iterator.next();
          if (done) break;
          arm(IDLE_TIMEOUT_MS, "idle");
          handle(value);
        }
        clearTimeout(timer);
        writeEvent(res, { type: "done", finishReason });
        return; // D
      } catch (err) {
        clearTimeout(timer);
        record.ok = false;
        record.ms = Date.now() - started;
        if (abortCause) break; // Stop or the time limit: end without trying another model
        const error = attemptAbort === "timeout" ? Object.assign(new Error("attempt timeout"), { attemptTimeout: true }) : attemptAbort === "idle" ? new UpstreamError(0, "", "midstream") : err;
        const f = failureKind(error);
        health.recordFailure(model.id, f.kind);
        if (f.provider) {
          health.recordProviderFailure(model.provider, f.provider.kind, { scope: f.provider.scope });
          (f.provider.scope === "free" ? excludedFree : excludedProviders).add(model.provider);
        }
        const mapped = attemptAbort === "idle" ? new HttpError(502, "The model stopped responding partway through. Try regenerating.", "idle_timeout") : mapUpstreamError(error, provider);
        record.error = mapped.code;
        record.kind = f.kind;
        record.phase = phase;
        lastErr = { mapped };
        if (phase === "C") {
          // Answer text has reached the browser: never switch models now.
          writeEvent(res, { type: "error", message: mapped.message, code: mapped.code });
          return;
        }
        if (phase === "B") {
          // Only reasoning was sent: if another model is tried, the browser first discards this attempt.
          // If none is (manual model, attempts used up), the reasoning stays with the error, as before.
          pendingReset = { type: "reset", message: "The model is busy. Trying another available model…", code: mapped.code };
        }
        if (!f.retryable) break;
      }
    }

    // No attempt finished.
    if (abortCause === "client") return;
    let failure;
    if (abortCause === "max_duration") failure = headersSent
      ? new HttpError(504, `This demo stops a single response after ${Math.round(limitMs / 1000)} seconds. Use Continue to keep going.`, "max_duration")
      : new HttpError(504, "No model started responding before the time limit. Try again.", "upstream_timeout");
    else {
      failure = lastErr?.mapped ?? new HttpError(503, "No model is available right now. Try again shortly.", "upstream_busy");
      if (attempts.length > 1) failure.message = `No available model could answer right now (tried ${attempts.map((a) => label(a.model)).join(", ")}). ${failure.message}`;
    }
    if (!headersSent) throw failure;
    writeEvent(res, { type: "error", message: failure.message, code: failure.code });
  } finally {
    clearTimeout(maxTimer);
    finished = true;
    if (headersSent) {
      await release(); // free the slot before ending: the platform may freeze the request after
      res.end();
    }
  }
}

/** Routing details for the developer view: decisions and outcomes only, never keys or message text. */
function debugInfo(decision, entry, attempts, order) {
  return {
    mode: "manual",
    task: { type: decision.task.type, tier: decision.task.tier, signals: decision.task.signals },
    requirements: decision.need,
    candidates: decision.candidates.slice(0, 8).map((c) => ({ model: c.model.id, provider: c.model.provider, score: c.score, ...c.parts, bonus: c.bonus })),
    excluded: decision.excluded,
    selected: { model: entry.model.id, provider: entry.model.provider },
    attempts,
    fallbacksAvailable: order.filter((c) => !attempts.some((a) => a.model === c.model.id)).slice(0, 4).map((c) => c.model.id),
  };
}

const ROUTES = {
  "GET /api/health": (req, res, url) => healthRoute(res, url.searchParams.has("fresh")),
  "GET /api/models": (req, res) => modelsRoute(res),
  "POST /api/chat": (req, res) => chat(req, res),
};

const KNOWN_PATHS = new Set(Object.keys(ROUTES).map((k) => k.split(" ")[1]));

function logRequest(req, res, path, started) {
  if (process.env.LOG_REQUESTS === "false") return;
  // No headers, bodies, query strings, keys or raw IPs are logged.
  const aborted = res.writableFinished ? "" : " (client disconnected)";
  console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms client=${logId(clientIp(req))}${aborted}`);
}

/** Handles /api/* requests. Returns false if the URL is not an API route. */
export async function handleApi(req, res) {
  const url = new URL(req.originalUrl ?? req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;
  const started = Date.now();
  res.on("close", () => logRequest(req, res, url.pathname, started));
  const route = `${req.method} ${url.pathname}`;
  try {
    if (req.method !== "GET" && !isSameOrigin(req)) throw new HttpError(403, "Cross-origin requests are not allowed.", "forbidden_origin");
    const handler = ROUTES[route];
    if (!handler) {
      if (KNOWN_PATHS.has(url.pathname)) throw new HttpError(405, "Method not allowed.", "method_not_allowed");
      throw new HttpError(404, "Unknown API route.", "not_found");
    }
    await handler(req, res, url);
  } catch (err) {
    const known = err instanceof HttpError;
    // Unexpected errors are logged server-side only; clients get a generic message.
    if (!known) console.error(`[api] ${route} failed:`, err instanceof Error ? err.stack : String(err));
    const message = known ? err.message : "Unexpected server error.";
    const code = known ? err.code : "server_error";
    if (res.headersSent) {
      if (!res.writableEnded) {
        writeEvent(res, { type: "error", message, code });
        res.end();
      }
    } else {
      sendJson(res, known ? err.status : 500, { error: { message, code } }, (known && err.headers) || {});
    }
  }
  return true;
}
