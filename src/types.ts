export type Role = "user" | "assistant";
export type MessageStatus = "streaming" | "done" | "stopped" | "error";
export type ReasoningMode = "toggle" | "always" | "none";

export interface ModelInfo {
  id: string;
  label: string;
  vendor: string;
  /** Service that runs the model ("Gemini API", "OpenRouter"). */
  provider: string;
  description: string;
  reasoning: ReasoningMode;
  /** Largest output this deployment allows for the model: min(300K app cap, verified API max). */
  maxOutput: number;
  /** Total prompt + output tokens, when the model enforces one (else null). */
  contextWindow: number | null;
  vision?: boolean;
  free?: boolean;
  /** Runtime health from the router: "cooling" = temporarily skipped after failures. */
  status?: "ok" | "degraded" | "cooling";
}

/** How a reply was routed (from the stream's start event). */
export interface RouteInfo {
  mode: "manual";
  provider: string;
  model: string;
  task: string;
  reason: string;
  fallbackFrom: string[];
}

/** Deployment limits reported by GET /api/models. */
export interface DemoLimits {
  outputCap: number;
  /** A single response is stopped after this many seconds (host function limit). */
  streamSeconds: number;
  rateLimitScope: "global" | "per-instance";
}

export interface AttachedFile {
  name: string;
  size: number;
  text: string;
}

export interface Usage {
  prompt: number | null;
  completion: number | null;
  reasoning: number | null;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  files?: AttachedFile[];
  // Assistant-only fields
  model?: string;
  status?: MessageStatus;
  reasoning?: string;
  reasoningMs?: number;
  error?: string;
  errorCode?: string;
  /** max_tokens actually sent (may be lower than requested to fit the context window). */
  maxTokens?: number;
  usage?: Usage;
  finishReason?: string | null;
  /** Assistant-only: how the router chose the model (and, with routing details on, the full decision). */
  route?: RouteInfo;
  routeDebug?: unknown;
  /** Transient status while the router replaces a model that failed before answering. */
  notice?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export type HealthStatus = "checking" | "ok" | "missing_key" | "auth_failed" | "unreachable";

/** Normalized events streamed by POST /api/chat (see server/api.mjs). */
export type ChatEvent =
  | { type: "start"; model: string; maxTokens?: number; limitSeconds?: number; route?: RouteInfo; debug?: unknown }
  /** The model failed after streaming only reasoning: discard everything from this attempt; another model starts next. */
  | { type: "reset"; message: string; code?: string }
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: string | null }
  | { type: "error"; message: string; code?: string };
