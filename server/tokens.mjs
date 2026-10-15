// Output-token limits. The app targets up to 300,000 output tokens (MAX_OUTPUT_TOKENS), but never
// more than the model/API accepts, and never more than fits in the model's context window
// after the prompt. If Gemini still rejects the value, parseLimitFromError() finds the real
// ceiling in its message so the request can be retried once instead of failing.

export const DEFAULT_OUTPUT_CAP = 300_000;
export const MIN_OUTPUT_TOKENS = 256;
const PROMPT_CHARS_PER_TOKEN = 3; // conservative (real text averages ~4 chars/token)
const CONTEXT_MARGIN = 256;

export function outputCap() {
  const n = Number.parseInt(process.env.MAX_OUTPUT_TOKENS ?? "", 10);
  return Number.isFinite(n) && n >= MIN_OUTPUT_TOKENS ? n : DEFAULT_OUTPUT_CAP;
}

/** Largest output the UI may offer for a model: min(app cap, verified API maximum). */
export function modelOutputLimit(model, cap = outputCap()) {
  return Math.min(cap, model.maxOutput);
}

/** max_tokens to send: the user's request clamped to the model limit and the context left after the prompt. */
export function planMaxTokens(model, requested, promptChars, cap = outputCap()) {
  const limit = modelOutputLimit(model, cap);
  const wanted = typeof requested === "number" && Number.isFinite(requested) ? Math.round(requested) : Math.min(4096, limit);
  let n = Math.min(limit, Math.max(MIN_OUTPUT_TOKENS, wanted));
  if (model.contextWindow) {
    const promptTokens = Math.ceil(promptChars / PROMPT_CHARS_PER_TOKEN) + CONTEXT_MARGIN;
    n = Math.min(n, model.contextWindow - promptTokens);
  }
  return n;
}

/**
 * Reads a token ceiling out of a Gemini validation error. Returns a smaller maxOutputTokens
 * that should be accepted, or null if the error isn't about the output limit.
 */
export function parseLimitFromError(text, sent) {
  // "…maxOutputTokens value of 100000 but the supported range is from 1 (inclusive) to 65537 (exclusive)…"
  let m = /maxOutputTokens.*?supported range is from \d+ \(inclusive\) to (\d+) \(exclusive\)/is.exec(text);
  if (m) return fit(Number(m[1]) - 1, sent);
  m = /maxOutputTokens.*?(?:must not exceed|must be (?:less than or equal to|at most)|maximum(?: allowed)?(?: value)? (?:is|of)) (\d+)/is.exec(text);
  if (m) return fit(Number(m[1]), sent);
  return null;
}

function fit(n, sent) {
  return n >= MIN_OUTPUT_TOKENS && n < sent ? n : null;
}
