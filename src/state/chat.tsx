import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, CONTINUE_PROMPT, streamChat, toApiContent, type ChatRequest } from "../lib/api";
import { preloadRenderers } from "../lib/renderers";
import { titleFrom, uid } from "../lib/util";
import type { AttachedFile, Message, ModelInfo } from "../types";
import { useConversationActions, type MessagePatch } from "./conversations";
import { useDraftActions } from "./draft";
import { useServer } from "./server";
import { useSettings } from "./settings";

interface Streaming {
  conversationId: string;
  messageId: string;
}

interface ChatContextValue {
  streaming: Streaming | null;
  send: (text: string, files: AttachedFile[]) => boolean;
  stop: () => void;
  /** Re-runs a reply; `model` overrides the active model. */
  regenerate: (conversationId: string, assistantMessageId: string, model?: ModelInfo) => void;
  editAndResend: (conversationId: string, userMessageId: string, text: string) => void;
  newChat: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

/** Only completed turns are sent back as context; failed/empty assistant turns are skipped. */
function toApiMessages(history: Message[]): ChatRequest["messages"] {
  return history
    .filter((m) => m.role === "user" || m.content.trim())
    .map((m) => ({ role: m.role, content: m.role === "user" ? toApiContent(m) : m.content }));
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { dispatch, getState } = useConversationActions();
  // Read through a ref so moving a slider doesn't recreate the chat API and re-render every message.
  const { settings } = useSettings();
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const { activeModel, recheckHealth } = useServer();
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const { setDraft, focusComposer } = useDraftActions();
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (conversationId: string, history: Message[], model: ModelInfo) => {
      const messageId = uid();
      preloadRenderers();
      dispatch({
        type: "addMessage",
        id: conversationId,
        message: { id: messageId, role: "assistant", content: "", createdAt: Date.now(), model: model.id, status: "streaming" },
      });
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setStreaming({ conversationId, messageId });

      const patch = (p: MessagePatch) => dispatch({ type: "patchMessage", id: conversationId, messageId, patch: p });

      // Batch streamed text into one state update per animation frame.
      let pending = { content: "", reasoning: "" };
      let frame = 0;
      let reasoningStart: number | null = null;
      let reasoningMs: number | undefined;
      const flush = () => {
        frame = 0;
        if (!pending.content && !pending.reasoning) return;
        const p = pending;
        pending = { content: "", reasoning: "" };
        patch((m) => ({
          content: m.content + p.content,
          reasoning: p.reasoning ? (m.reasoning ?? "") + p.reasoning : m.reasoning,
          reasoningMs,
        }));
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(flush);
      };

      let streamError: string | undefined;
      let streamErrorCode: string | undefined;
      let finishReason: string | null = null;
      const settings = settingsRef.current;
      const previousModel = [...history].reverse().find((m) => m.role === "assistant" && m.content && m.model)?.model;
      try {
        await streamChat(
          {
            model: model.id,
            messages: toApiMessages(history),
            system: settings.systemPrompt || undefined,
            temperature: settings.temperature,
            topP: settings.topP,
            maxTokens: Math.min(settings.maxTokens, model.maxOutput),
            thinking: model.reasoning === "toggle" ? settings.thinking : true,
            allowFallback: settings.manualFallback,
            debug: settings.showRouting || undefined,
            continuation: history.at(-1)?.content === CONTINUE_PROMPT || undefined,
            previousModel,
          },
          ctrl.signal,
          (event) => {
            switch (event.type) {
              case "start":
                // The router reports which model actually answers (in Auto mode, chosen per message).
                patch({ model: event.model, maxTokens: event.maxTokens, route: event.route, routeDebug: event.debug, notice: undefined });
                break;
              case "reset":
                // Only reasoning had streamed when the model failed: drop that attempt completely
                // (including any text still waiting for the next frame) so the next model starts clean.
                cancelAnimationFrame(frame);
                frame = 0;
                pending = { content: "", reasoning: "" };
                reasoningStart = null;
                reasoningMs = undefined;
                patch({ content: "", reasoning: undefined, reasoningMs: undefined, usage: undefined, notice: event.message });
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
                patch({ usage: event.usage });
                break;
              case "done":
                finishReason = event.finishReason;
                break;
              case "error":
                streamError = event.message;
                streamErrorCode = event.code;
                break;
            }
          },
        );
        cancelAnimationFrame(frame);
        flush();
        if (reasoningStart !== null) reasoningMs ??= Date.now() - reasoningStart;
        patch({ status: streamError ? "error" : "done", error: streamError, errorCode: streamErrorCode, finishReason, reasoningMs, notice: undefined });
      } catch (err) {
        cancelAnimationFrame(frame);
        flush();
        if (reasoningStart !== null) reasoningMs ??= Date.now() - reasoningStart;
        if (ctrl.signal.aborted) {
          patch({ status: "stopped", reasoningMs, notice: undefined });
        } else {
          const message = err instanceof Error ? err.message : "Something went wrong.";
          patch({ status: "error", error: message, errorCode: err instanceof ApiError ? err.code : undefined, reasoningMs, notice: undefined });
          if (err instanceof ApiError && (err.code === "network" || err.code === "auth_failed" || err.code === "missing_key")) recheckHealth();
        }
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
        setStreaming((s) => (s?.messageId === messageId ? null : s));
      }
    },
    [dispatch, recheckHealth],
  );

  const send = useCallback(
    (text: string, files: AttachedFile[]) => {
      const content = text.trim();
      if ((!content && !files.length) || streaming || !activeModel) return false;

      const state = getState();
      let conversation = state.conversations.find((c) => c.id === state.activeId);
      if (!conversation) {
        const now = Date.now();
        conversation = { id: uid(), title: titleFrom(content || files[0].name), createdAt: now, updatedAt: now, messages: [] };
        dispatch({ type: "create", conversation });
      }
      const userMessage: Message = { id: uid(), role: "user", content, createdAt: Date.now(), files: files.length ? files : undefined };
      dispatch({ type: "addMessage", id: conversation.id, message: userMessage });
      void run(conversation.id, [...conversation.messages, userMessage], activeModel);
      return true;
    },
    [streaming, activeModel, getState, dispatch, run],
  );

  const regenerate = useCallback(
    (conversationId: string, assistantMessageId: string, model?: ModelInfo) => {
      const conversation = getState().conversations.find((c) => c.id === conversationId);
      const idx = conversation?.messages.findIndex((m) => m.id === assistantMessageId) ?? -1;
      const target = model ?? activeModel;
      if (!conversation || idx < 0 || streaming || !target) return;
      dispatch({ type: "truncateFrom", id: conversationId, messageId: assistantMessageId });
      void run(conversationId, conversation.messages.slice(0, idx), target);
    },
    [getState, streaming, activeModel, dispatch, run],
  );

  const editAndResend = useCallback(
    (conversationId: string, userMessageId: string, text: string) => {
      const conversation = getState().conversations.find((c) => c.id === conversationId);
      const idx = conversation?.messages.findIndex((m) => m.id === userMessageId) ?? -1;
      if (!conversation || idx < 0 || streaming || !activeModel) return;
      const original = conversation.messages[idx];
      const edited: Message = { ...original, id: uid(), content: text.trim(), createdAt: Date.now() };
      dispatch({ type: "truncateFrom", id: conversationId, messageId: userMessageId });
      dispatch({ type: "addMessage", id: conversationId, message: edited });
      void run(conversationId, [...conversation.messages.slice(0, idx), edited], activeModel);
    },
    [getState, streaming, activeModel, dispatch, run],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const newChat = useCallback(() => {
    dispatch({ type: "select", id: null });
    setDraft("");
    focusComposer();
  }, [dispatch, setDraft, focusComposer]);

  const value = useMemo(
    () => ({ streaming, send, stop, regenerate, editAndResend, newChat }),
    [streaming, send, stop, regenerate, editAndResend, newChat],
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used inside ChatProvider");
  return ctx;
}
