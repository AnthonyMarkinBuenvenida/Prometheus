// Career Guidance Factory runs: starts, resumes and stops the four-agent stream (POST /api/career)
// and writes each agent's result into its roadmap conversation as it streams.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, streamCareer } from "../lib/api";
import { AGENTS, careerTitle, EMPTY_PROFILE, newRun, resumeIndex } from "../lib/career";
import { preloadRenderers } from "../lib/renderers";
import { load, save } from "../lib/storage";
import { uid } from "../lib/util";
import type { AgentId, AgentRun, CareerProfile, CareerRun } from "../types";
import { useConversationActions } from "./conversations";
import { useServer } from "./server";
import { useSettings } from "./settings";

interface CareerContextValue {
  /** Conversation whose agents are streaming right now. */
  running: string | null;
  /** The form's current values (kept in the browser between visits). */
  draft: CareerProfile;
  setDraft: (profile: CareerProfile) => void;
  /** Shows the form; `profile` pre-fills it (e.g. to adjust an existing roadmap). */
  openForm: (profile?: CareerProfile) => void;
  start: (profile: CareerProfile) => boolean;
  /** Continues a roadmap from its first unfinished agent. */
  resume: (conversationId: string) => void;
  stop: () => void;
}

const CareerContext = createContext<CareerContextValue | null>(null);

export function CareerProvider({ children }: { children: ReactNode }) {
  const { dispatch, getState } = useConversationActions();
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const { activeModel, recheckHealth } = useServer();
  const [running, setRunning] = useState<string | null>(null);
  const [draft, setDraftState] = useState<CareerProfile>(() => ({ ...EMPTY_PROFILE, ...load<Partial<CareerProfile>>("careerDraft", {}) }));
  const abortRef = useRef<AbortController | null>(null);

  const setDraft = useCallback((profile: CareerProfile) => {
    setDraftState(profile);
    save("careerDraft", profile);
  }, []);

  const run = useCallback(
    // `career` is passed by start(): the conversation it just created isn't in getState() until React re-renders.
    async (conversationId: string, from: number, career?: CareerRun) => {
      const existing = career ?? getState().conversations.find((c) => c.id === conversationId)?.career;
      if (!existing || !activeModel) return;
      preloadRenderers();
      const model = activeModel;
      const profile = existing.profile;
      const previous = Object.fromEntries(AGENTS.slice(0, from).map((a) => [a.id, existing.agents[a.id].content]));

      const patchRun = (fn: (r: CareerRun) => CareerRun) => dispatch({ type: "patchCareer", id: conversationId, patch: fn });
      const patchAgent = (id: AgentId, p: Partial<AgentRun> | ((a: AgentRun) => Partial<AgentRun>)) =>
        patchRun((r) => ({ ...r, agents: { ...r.agents, [id]: { ...r.agents[id], ...(typeof p === "function" ? p(r.agents[id]) : p) } } }));

      // Agents from `from` on start over; the first one is running right away.
      patchRun((r) => {
        const agents = { ...r.agents };
        AGENTS.forEach((a, i) => {
          if (i >= from) agents[a.id] = { status: i === from ? "running" : "pending", content: "" };
        });
        return { ...r, agents };
      });

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setRunning(conversationId);

      // Batch streamed text into one state update per animation frame (as in chat).
      let current: AgentId = AGENTS[from].id;
      let pending = { content: "", reasoning: "" };
      let frame = 0;
      let reasoningStart: number | null = null;
      let reasoningMs: number | undefined;
      const flush = () => {
        frame = 0;
        if (!pending.content && !pending.reasoning) return;
        const p = pending;
        const ms = reasoningMs;
        pending = { content: "", reasoning: "" };
        patchAgent(current, (a) => ({ content: a.content + p.content, reasoning: p.reasoning ? (a.reasoning ?? "") + p.reasoning : a.reasoning, reasoningMs: ms }));
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(flush);
      };
      const switchTo = (id: AgentId) => {
        if (id === current) return;
        cancelAnimationFrame(frame);
        flush();
        current = id;
        reasoningStart = null;
        reasoningMs = undefined;
      };

      // Assigned inside the event callback, so declared with its full type (no narrowing to null).
      let failed = null as { message: string; code?: string } | null;
      const s = settingsRef.current;
      try {
        await streamCareer(
          {
            model: model.id,
            profile,
            temperature: s.temperature,
            topP: s.topP,
            thinking: model.reasoning === "toggle" ? s.thinking : true,
            allowFallback: s.manualFallback,
            from: from || undefined,
            previous: from ? previous : undefined,
          },
          ctrl.signal,
          (event) => {
            if (event.agent) switchTo(event.agent);
            switch (event.type) {
              case "start":
                patchAgent(current, { status: "running", model: event.model, route: event.route, notice: undefined });
                break;
              case "reset":
                cancelAnimationFrame(frame);
                frame = 0;
                pending = { content: "", reasoning: "" };
                reasoningStart = null;
                reasoningMs = undefined;
                patchAgent(current, { content: "", reasoning: undefined, reasoningMs: undefined, usage: undefined, notice: event.message });
                break;
              case "reasoning":
                reasoningStart ??= Date.now();
                pending.reasoning += event.text;
                schedule();
                break;
              case "content":
                if (reasoningStart !== null && reasoningMs === undefined) reasoningMs = Date.now() - reasoningStart;
                pending.content += event.text;
                schedule();
                break;
              case "usage":
                patchAgent(current, { usage: event.usage });
                break;
              case "agent-done": {
                cancelAnimationFrame(frame);
                flush();
                if (reasoningStart !== null) reasoningMs ??= Date.now() - reasoningStart;
                patchAgent(current, { status: "done", finishReason: event.finishReason, reasoningMs, notice: undefined });
                const next = AGENTS[AGENTS.findIndex((a) => a.id === current) + 1];
                if (next) patchAgent(next.id, { status: "running" });
                break;
              }
              case "error":
                failed = { message: event.message, code: event.code };
                break;
            }
          },
        );
        cancelAnimationFrame(frame);
        flush();
        if (failed) patchAgent(current, { status: "error", error: failed.message, errorCode: failed.code, notice: undefined });
      } catch (err) {
        cancelAnimationFrame(frame);
        flush();
        if (ctrl.signal.aborted) {
          patchAgent(current, { status: "stopped", notice: undefined });
        } else {
          const message = err instanceof Error ? err.message : "Something went wrong.";
          patchAgent(current, { status: "error", error: message, errorCode: err instanceof ApiError ? err.code : undefined, notice: undefined });
          if (err instanceof ApiError && (err.code === "network" || err.code === "auth_failed" || err.code === "missing_key")) recheckHealth();
        }
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
        setRunning((r) => (r === conversationId ? null : r));
      }
    },
    [activeModel, dispatch, getState, recheckHealth],
  );

  const start = useCallback(
    (profile: CareerProfile) => {
      if (running || !activeModel || !profile.skills.trim()) return false;
      const now = Date.now();
      const conversation = { id: uid(), title: careerTitle(profile), createdAt: now, updatedAt: now, messages: [], kind: "career" as const, career: newRun(profile) };
      dispatch({ type: "create", conversation });
      void run(conversation.id, 0, conversation.career);
      return true;
    },
    [running, activeModel, dispatch, run],
  );

  const resume = useCallback(
    (conversationId: string) => {
      const career = getState().conversations.find((c) => c.id === conversationId)?.career;
      const from = career ? resumeIndex(career) : -1;
      if (running || from < 0) return;
      void run(conversationId, from);
    },
    [getState, running, run],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const openForm = useCallback(
    (profile?: CareerProfile) => {
      if (profile) setDraft(profile);
      dispatch({ type: "openCareerForm" });
    },
    [dispatch, setDraft],
  );

  const value = useMemo(() => ({ running, draft, setDraft, openForm, start, resume, stop }), [running, draft, setDraft, openForm, start, resume, stop]);
  return <CareerContext.Provider value={value}>{children}</CareerContext.Provider>;
}

export function useCareer() {
  const ctx = useContext(CareerContext);
  if (!ctx) throw new Error("useCareer must be used inside CareerProvider");
  return ctx;
}
