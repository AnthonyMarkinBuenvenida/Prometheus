// Settings shape, defaults and validation. Pure (no React) so it can be unit-tested.

export const THEMES = ["dark", "black", "light"] as const;
export type Theme = (typeof THEMES)[number];

/** Browser chrome color (mobile address bar) per theme; mirrors --bg-app in tokens.css. */
export const THEME_COLOR: Record<Theme, string> = { dark: "#0b0b0d", black: "#000000", light: "#ffffff" };

export interface Settings {
  // Generation (sent with each request)
  model: string | null;
  temperature: number;
  topP: number;
  maxTokens: number;
  thinking: boolean;
  systemPrompt: string;
  // Display
  theme: Theme;
  fontSize: "small" | "medium" | "large";
  chatWidth: "standard" | "wide";
  // Routing
  /** Manual model only: let the router try another model when the chosen one fails. */
  manualFallback: boolean;
  /** Developer view: show the full routing decision under each reply. */
  showRouting: boolean;
  // Behavior
  sendOnEnter: boolean;
  expandReasoning: boolean;
  sidebarCollapsed: boolean;
}

export const GENERATION_DEFAULTS = {
  temperature: 0.6,
  topP: 0.95,
  maxTokens: 4000,
  thinking: true,
  systemPrompt: "",
} satisfies Partial<Settings>;

export const DEFAULT_SETTINGS: Settings = {
  model: null, // the server's default model
  ...GENERATION_DEFAULTS,
  theme: "dark",
  fontSize: "medium",
  chatWidth: "standard",
  manualFallback: false,
  showRouting: false,
  sendOnEnter: true,
  expandReasoning: false,
  sidebarCollapsed: false,
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const num = (v: unknown, min: number, max: number, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);

/** Merges stored (possibly old or corrupted) settings over the defaults, field by field. */
export function normalizeSettings(stored: unknown): Settings {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  return {
    // No saved choice, or "auto" saved before automatic selection was removed → the server's default model.
    model: typeof s.model === "string" && s.model && s.model !== "auto" ? s.model : d.model,
    temperature: num(s.temperature, 0, 2, d.temperature),
    topP: num(s.topP, 0.01, 1, d.topP),
    // The UI clamps to the active model's limit; here only enforce a sane positive range.
    maxTokens: Math.round(num(s.maxTokens, 256, 1_048_576, d.maxTokens)),
    thinking: bool(s.thinking, d.thinking),
    systemPrompt: typeof s.systemPrompt === "string" ? s.systemPrompt.slice(0, 8000) : d.systemPrompt,
    theme: oneOf(s.theme, THEMES, d.theme),
    fontSize: oneOf(s.fontSize, ["small", "medium", "large"] as const, d.fontSize),
    chatWidth: oneOf(s.chatWidth, ["standard", "wide"] as const, d.chatWidth),
    manualFallback: bool(s.manualFallback, d.manualFallback),
    showRouting: bool(s.showRouting, d.showRouting),
    sendOnEnter: bool(s.sendOnEnter, d.sendOnEnter),
    expandReasoning: bool(s.expandReasoning, d.expandReasoning),
    sidebarCollapsed: bool(s.sidebarCollapsed, d.sidebarCollapsed),
  };
}
