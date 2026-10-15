import type { ChatEvent, DemoLimits, HealthStatus, Message, ModelInfo } from "../types";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  try {
    const body = await res.json();
    if (body?.error?.message) return new ApiError(body.error.message, res.status, body.error.code);
  } catch {
    // non-JSON error body
  }
  // Platform-level failures (e.g. a function timeout) don't return our JSON error shape.
  if (res.status === 504) return new ApiError("The server took too long to respond. Try again.", 504, "gateway_timeout");
  return new ApiError(`Request failed (${res.status}).`, res.status);
}

function networkError(): ApiError {
  return new ApiError("Couldn't reach the Prometheus server. Check that it's running and you're online.", 0, "network");
}

/** fetch() for /api routes: maps network failures consistently. */
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch (err) {
    if (init?.signal?.aborted) throw err;
    throw networkError();
  }
}

function postJson(path: string, body: unknown, signal?: AbortSignal) {
  return apiFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
}

export async function fetchModels(): Promise<{ models: ModelInfo[]; defaultModel: string; limits: DemoLimits }> {
  const res = await apiFetch("/api/models");
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

export async function fetchHealth(fresh = false): Promise<{ status: Exclude<HealthStatus, "checking">; message: string }> {
  try {
    const res = await apiFetch(fresh ? "/api/health?fresh" : "/api/health");
    if (!res.ok) return { status: "unreachable", message: "The Prometheus server returned an error." };
    return await res.json();
  } catch {
    return { status: "unreachable", message: "Couldn't reach the Prometheus server." };
  }
}

/** Formats a user message (plus inlined text attachments) the way the model sees it. */
export function toApiContent(message: Message): string {
  if (!message.files?.length) return message.content;
  const files = message.files.map((f) => `<file name="${f.name}">\n${f.text}\n</file>`).join("\n\n");
  return message.content ? `${files}\n\n${message.content}` : files;
}

/** Sent by the Continue button; the router keeps continuations on the model that wrote the answer. */
export const CONTINUE_PROMPT = "Continue exactly where you stopped. Do not repeat anything you already wrote.";

export interface ChatRequest {
  /** The chosen model's id. */
  model: string;
  messages: { role: "user" | "assistant"; content: string }[];
  system?: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  thinking: boolean;
  /** Manual model only: allow the router to try another model if it fails. */
  allowFallback?: boolean;
  /** Ask for the full routing decision (developer view). */
  debug?: boolean;
  continuation?: boolean;
  /** Model that wrote the previous answer (routing context for follow-ups and Continue). */
  previousModel?: string;
}

/** Streams a chat completion. Resolves when the stream ends; throws ApiError, or the abort reason if cancelled. */
export async function streamChat(req: ChatRequest, signal: AbortSignal, onEvent: (e: ChatEvent) => void): Promise<void> {
  const res = await postJson("/api/chat", req, signal);
  if (!res.ok || !res.body) throw await errorFrom(res);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let ended = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let sep;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (!frame.startsWith("data:")) continue;
        const event = JSON.parse(frame.slice(5)) as ChatEvent;
        if (event.type === "done" || event.type === "error") ended = true;
        onEvent(event);
      }
    }
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ApiError("The connection dropped while the answer was streaming.", 0, "stream_interrupted");
  }
  if (!ended) throw new ApiError("The response ended unexpectedly. Try regenerating.", 0, "stream_interrupted");
}
