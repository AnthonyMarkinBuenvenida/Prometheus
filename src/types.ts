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
  /** "career": a Career Guidance roadmap (stored in `career`; `messages` stays empty). */
  kind?: "career";
  career?: CareerRun;
}

// ---------- Career Guidance Factory ----------

export type AgentId = "skills" | "career" | "learning" | "jobs";

export interface CareerProfile {
  skills: string;
  interests: string;
  education: string;
  goals: string;
  location: string;
}

export type AgentStatus = "pending" | "running" | "done" | "error" | "stopped";

/** One agent's result within a roadmap. */
export interface AgentRun {
  status: AgentStatus;
  content: string;
  reasoning?: string;
  reasoningMs?: number;
  model?: string;
  route?: RouteInfo;
  usage?: Usage;
  finishReason?: string | null;
  error?: string;
  errorCode?: string;
  /** Transient status while another model replaces one that failed before answering. */
  notice?: string;
}

export interface CareerRun {
  profile: CareerProfile;
  agents: Record<AgentId, AgentRun>;
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

/** Events streamed by POST /api/career: chat events tagged with the agent they belong to. */
export type CareerEvent =
  | (ChatEvent & { agent?: AgentId })
  /** One agent finished; the next one starts. */
  | { type: "agent-done"; agent: AgentId; finishReason: string | null };
