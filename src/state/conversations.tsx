import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react";
import { settleRun } from "../lib/career";
import { load, save } from "../lib/storage";
import type { CareerRun, Conversation, Message } from "../types";

interface State {
  conversations: Conversation[]; // most recently updated first
  activeId: string | null;
  /** The Career Guidance form is open (no conversation selected). */
  careerForm: boolean;
}

export type MessagePatch = Partial<Message> | ((m: Message) => Partial<Message>);

export type ConversationAction =
  | { type: "create"; conversation: Conversation }
  | { type: "select"; id: string | null }
  | { type: "openCareerForm" }
  | { type: "rename"; id: string; title: string }
  | { type: "delete"; id: string }
  | { type: "clear" }
  | { type: "addMessage"; id: string; message: Message }
  | { type: "patchMessage"; id: string; messageId: string; patch: MessagePatch }
  /** Removes the given message and everything after it. */
  | { type: "truncateFrom"; id: string; messageId: string }
  | { type: "patchCareer"; id: string; patch: (run: CareerRun) => CareerRun };

function touch(conversations: Conversation[], id: string, fn: (c: Conversation) => Conversation, bump = true): Conversation[] {
  const idx = conversations.findIndex((c) => c.id === id);
  if (idx < 0) return conversations;
  const updated = fn(conversations[idx]);
  if (!bump) return conversations.map((c, i) => (i === idx ? updated : c));
  return [{ ...updated, updatedAt: Date.now() }, ...conversations.filter((_, i) => i !== idx)];
}

function reducer(state: State, action: ConversationAction): State {
  switch (action.type) {
    case "create":
      return { conversations: [action.conversation, ...state.conversations], activeId: action.conversation.id, careerForm: false };
    case "select":
      return { ...state, activeId: action.id, careerForm: false };
    case "openCareerForm":
      return { ...state, activeId: null, careerForm: true };
    case "rename":
      return { ...state, conversations: touch(state.conversations, action.id, (c) => ({ ...c, title: action.title }), false) };
    case "delete":
      return {
        conversations: state.conversations.filter((c) => c.id !== action.id),
        activeId: state.activeId === action.id ? null : state.activeId,
        careerForm: state.careerForm,
      };
    case "clear":
      return { conversations: [], activeId: null, careerForm: false };
    case "addMessage":
      return { ...state, conversations: touch(state.conversations, action.id, (c) => ({ ...c, messages: [...c.messages, action.message] })) };
    case "patchMessage":
      return {
        ...state,
        conversations: touch(
          state.conversations,
          action.id,
          (c) => ({
            ...c,
            messages: c.messages.map((m) => {
              if (m.id !== action.messageId) return m;
              const patch = typeof action.patch === "function" ? action.patch(m) : action.patch;
              return { ...m, ...patch };
            }),
          }),
          false,
        ),
      };
    case "truncateFrom":
      return {
        ...state,
        conversations: touch(state.conversations, action.id, (c) => {
          const idx = c.messages.findIndex((m) => m.id === action.messageId);
          return idx < 0 ? c : { ...c, messages: c.messages.slice(0, idx) };
        }),
      };
    case "patchCareer":
      return { ...state, conversations: touch(state.conversations, action.id, (c) => (c.career ? { ...c, career: action.patch(c.career) } : c), false) };
  }
}

function initialState(): State {
  const conversations = load<Conversation[]>("conversations", []);
  // A reload mid-stream leaves messages marked "streaming": they can never finish now.
  for (const c of conversations) {
    for (const m of c.messages) if (m.status === "streaming") m.status = "stopped";
    if (c.career) c.career = settleRun(c.career);
  }
  return { conversations, activeId: null, careerForm: false };
}

interface ConversationsContextValue {
  conversations: Conversation[];
  active: Conversation | null;
  activeId: string | null;
  careerForm: boolean;
  dispatch: Dispatch<ConversationAction>;
  /** Latest state, readable from async callbacks without stale closures. */
  getState: () => State;
}

const ConversationsContext = createContext<ConversationsContextValue | null>(null);

/** Stable actions: components that only dispatch don't re-render on every streamed frame. */
interface ConversationActions {
  dispatch: Dispatch<ConversationAction>;
  getState: () => State;
}
const ConversationActionsContext = createContext<ConversationActions | null>(null);

export function ConversationsProvider({ children, onPersistError }: { children: ReactNode; onPersistError?: () => void }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const failedRef = useRef(false);
  const savedRef = useRef(state.conversations);
  const firstPendingRef = useRef<number | null>(null);

  const persist = useCallback(() => {
    firstPendingRef.current = null;
    const current = stateRef.current.conversations;
    if (current === savedRef.current) return;
    const ok = save("conversations", current);
    if (ok) savedRef.current = current;
    if (!ok && !failedRef.current) onPersistError?.();
    failedRef.current = !ok;
  }, [onPersistError]);

  // Streaming patches state ~60x/s: debounce writes (400ms), but never wait more than 2s,
  // so a long uninterrupted stream is still saved as it goes.
  useEffect(() => {
    if (state.conversations === savedRef.current) return;
    const now = Date.now();
    firstPendingRef.current ??= now;
    const wait = Math.max(0, Math.min(400, firstPendingRef.current + 2000 - now));
    const t = setTimeout(persist, wait);
    return () => clearTimeout(t);
  }, [state.conversations, persist]);

  // Flush immediately when the tab is hidden or closed, so the last edits aren't lost.
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && persist();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", persist);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", persist);
    };
  }, [persist]);

  const getState = useCallback(() => stateRef.current, []);
  const actions = useMemo(() => ({ dispatch, getState }), [getState]);
  const value = useMemo<ConversationsContextValue>(
    () => ({
      conversations: state.conversations,
      activeId: state.activeId,
      careerForm: state.careerForm,
      active: state.conversations.find((c) => c.id === state.activeId) ?? null,
      dispatch,
      getState,
    }),
    [state, getState],
  );
  return (
    <ConversationActionsContext.Provider value={actions}>
      <ConversationsContext.Provider value={value}>{children}</ConversationsContext.Provider>
    </ConversationActionsContext.Provider>
  );
}

export function useConversationActions() {
  const ctx = useContext(ConversationActionsContext);
  if (!ctx) throw new Error("useConversationActions must be used inside ConversationsProvider");
  return ctx;
}

export function useConversations() {
  const ctx = useContext(ConversationsContext);
  if (!ctx) throw new Error("useConversations must be used inside ConversationsProvider");
  return ctx;
}
