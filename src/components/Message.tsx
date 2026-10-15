import { memo, useEffect, useState } from "react";
import { CONTINUE_PROMPT } from "../lib/api";
import { copyText, formatBytes, formatDuration } from "../lib/util";
import { useChat } from "../state/chat";
import { useServer } from "../state/server";
import { useSettings } from "../state/settings";
import { useToast } from "../state/toast";
import type { Message } from "../types";
import { Icon, Logo } from "./Icon";
import { Markdown } from "./Markdown";
import "./Message.css";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  return (
    <button
      type="button"
      className="icon-btn icon-btn-sm"
      aria-label={copied ? "Copied" : label}
      data-tooltip={copied ? "Copied" : label}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } else {
          toast("Couldn't access the clipboard", "error");
        }
      }}
    >
      <Icon name={copied ? "check" : "copy"} size={15} />
    </button>
  );
}

export function Reasoning({ text, ms, active }: { text: string; ms?: number; active: boolean }) {
  const { settings } = useSettings();
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? (active || settings.expandReasoning);
  const label = active ? "Thinking…" : ms ? `Thought for ${formatDuration(ms)}` : "Thoughts";
  return (
    <div className={`reasoning${open ? " is-open" : ""}`}>
      <button type="button" className={`reasoning-toggle${active ? " is-active" : ""}`} aria-expanded={open} onClick={() => setUserOpen(!open)}>
        <Icon name="spark" size={15} />
        <span>{label}</span>
        <Icon name="chevronRight" size={14} className="reasoning-chevron" />
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  );
}


/** Seconds since `since`, ticking while mounted (used only while waiting for the first token). */
/** Developer view of a routing decision, in the documented "Request → …" format. */
function formatDecision(debug: unknown, route: NonNullable<Message["route"]>): string {
  const d = debug as {
    task: { type: string; tier: string; signals: string[] };
    requirements: { promptTokens: number; outputTokens: number; quality: string; reasoning: boolean; vision: boolean };
    candidates: { model: string; score: number }[];
    excluded: { id: string; reason: string }[];
    attempts: { model: string; ok: boolean; error?: string; ms: number }[];
    fallbacksAvailable: string[];
  };
  const req = d.requirements;
  const needs = [`~${req.promptTokens.toLocaleString()} prompt tokens`, `${req.outputTokens.toLocaleString()} output`, `ranked by ${req.quality} benchmark`, req.reasoning ? "reasoning" : "", req.vision ? "image input" : ""].filter(Boolean);
  return [
    "Request",
    `→ Task type: ${d.task.type} (${d.task.tier} tier)${d.task.signals.length ? ` · ${d.task.signals.join("; ")}` : ""}`,
    `→ Requirements: ${needs.join(", ")}`,
    `→ Eligible models: ${d.candidates.map((c) => `${c.model} (${c.score})`).join(", ") || "none"}`,
    d.excluded.length ? `→ Excluded: ${d.excluded.map((e) => `${e.id} (${e.reason})`).join(", ")}` : "",
    `→ Attempts: ${d.attempts.map((a) => `${a.model} ${a.ok ? "ok" : a.error} ${a.ms} ms`).join(" → ")}`,
    `→ Selected provider: ${route.provider}`,
    `→ Selected model: ${route.model}`,
    `→ Reason: ${route.reason}`,
    `→ Fallbacks available: ${d.fallbacksAvailable.join(", ") || "none"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Chip shown when a fallback model answered (or routing details are on): expands to why, and for developers the full decision. */
function RouteDetails({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const route = message.route;
  if (!route || (route.mode === "manual" && !route.fallbackFrom.length && !message.routeDebug)) return null;
  const label = route.provider;
  return (
    <>
      <button type="button" className={`msg-route${open ? " is-open" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{label}</span>
        {route.fallbackFrom.length > 0 && <span className="msg-route-flag">fallback</span>}
        <Icon name="chevronRight" size={12} className="msg-route-chevron" />
      </button>
      {open && (
        <div className="msg-route-panel">
          <p>{route.reason}</p>
          {route.fallbackFrom.length > 0 && <p>Tried first: {route.fallbackFrom.join(", ")}.</p>}
          {message.routeDebug != null && <pre className="msg-route-debug">{formatDecision(message.routeDebug, route)}</pre>}
        </div>
      )}
    </>
  );
}

function useElapsed(since: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

function Waiting({ label, since, notice }: { label: string; since: number; notice?: string }) {
  const s = useElapsed(since);
  if (notice) {
    // The router is replacing a model that failed before answering.
    return (
      <div className="typing" role="status">
        <span className="typing-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>{notice}</span>
      </div>
    );
  }
  return (
    <div className="typing" role="status">
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>
        Waiting for {label}… {s >= 5 && <span className="typing-elapsed">{s}s</span>}
        {s >= 12 && <span className="typing-note"> · Gemini is busy; thinking models can take a little while to start.</span>}
      </span>
    </div>
  );
}

function UserMessage({ message, conversationId }: { message: Message; conversationId: string }) {
  const { editAndResend, streaming } = useChat();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(message.content);

  const submit = () => {
    if (!value.trim() && !message.files?.length) return;
    setEditing(false);
    editAndResend(conversationId, message.id, value);
  };

  return (
    <div className="msg msg-user">
      {message.files && (
        <div className="msg-files">
          {message.files.map((f) => (
            <span key={f.name} className="file-chip" title={f.name}>
              <Icon name="file" size={15} />
              <span className="file-chip-name">{f.name}</span>
              <span className="file-chip-size">{formatBytes(f.size)}</span>
            </span>
          ))}
        </div>
      )}
      {editing ? (
        <div className="msg-edit">
          <textarea
            className="textarea"
            value={value}
            autoFocus
            rows={Math.min(10, Math.max(2, value.split("\n").length))}
            aria-label="Edit message"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="msg-edit-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={!!streaming}>
              Send
            </button>
          </div>
        </div>
      ) : (
        message.content && <div className="msg-bubble">{message.content}</div>
      )}
      {!editing && (
        <div className="msg-actions">
          {message.content && <CopyButton text={message.content} label="Copy message" />}
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="Edit and resend"
            data-tooltip={streaming ? "Wait for the response to finish" : "Edit and resend"}
            disabled={!!streaming}
            onClick={() => {
              setValue(message.content);
              setEditing(true);
            }}
          >
            <Icon name="pencil" size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function AssistantMessage({ message, conversationId, isLast }: { message: Message; conversationId: string; isLast: boolean }) {
  const { regenerate, send, streaming } = useChat();
  const { modelLabel } = useServer();
  const isStreaming = message.status === "streaming";
  const cutOff = !!message.content && ((message.status === "done" && message.finishReason === "length") || (message.status === "error" && message.errorCode === "max_duration"));
  const continueButton = isLast && cutOff && (
    <button type="button" className="btn btn-secondary btn-sm" disabled={!!streaming} onClick={() => send(CONTINUE_PROMPT, [])}>
      <Icon name="arrowDown" size={15} />
      Continue
    </button>
  );
  const thinkingNow = isStreaming && !message.content;
  const usage = message.usage;

  return (
    <div className="msg msg-assistant" aria-busy={isStreaming}>
      <div className="msg-meta">
        <span className="msg-avatar" aria-hidden="true">
          <Logo size={20} />
        </span>
        <span className="msg-model">{modelLabel(message.model)}</span>
      </div>
      {message.route && <div className="msg-route-row"><RouteDetails message={message} /></div>}

      {message.reasoning && <Reasoning text={message.reasoning} ms={message.reasoningMs} active={thinkingNow} />}

      {isStreaming && !message.content && !message.reasoning && <Waiting label={modelLabel(message.model)} since={message.createdAt} notice={message.notice} />}

      {message.content && <Markdown text={message.content} streaming={isStreaming} />}

      {message.status === "stopped" && (
        <p className="msg-note">
          <Icon name="stop" size={12} /> Stopped{message.content ? "" : " before any answer was written"}
        </p>
      )}
      {message.finishReason === "length" && message.status === "done" && (
        <div className="msg-note-row">
          <p className="msg-note">
            <Icon name="info" size={14} /> Reached the {message.maxTokens ? `${message.maxTokens.toLocaleString()}-token ` : ""}output limit.
          </p>
          {continueButton}
        </div>
      )}
      {message.status === "done" && !message.content && message.finishReason !== "length" && <p className="msg-note">The model returned an empty response.</p>}

      {message.status === "error" && (
        // Hitting the host's time limit isn't a failure: the text is kept and can be continued.
        <div className={`msg-error${message.errorCode === "max_duration" ? " is-paused" : ""}`} role="alert">
          <Icon name={message.errorCode === "max_duration" ? "info" : "alert"} size={18} />
          <div className="msg-error-text">
            <strong>{message.errorCode === "max_duration" ? "Paused at the time limit" : "Response failed"}</strong>
            <p>{message.error}</p>
          </div>
          {isLast && (
            <div className="msg-error-actions">
              {continueButton}
              <button type="button" className="btn btn-secondary btn-sm" disabled={!!streaming} onClick={() => regenerate(conversationId, message.id)}>
                <Icon name="refresh" size={15} />
                Retry
              </button>
            </div>
          )}
        </div>
      )}

      {!isStreaming && (
        <div className="msg-actions msg-actions-assistant">
          {message.content && <CopyButton text={message.content} label="Copy response" />}
          {isLast && message.status !== "error" && (
            <button
              type="button"
              className="icon-btn icon-btn-sm"
              aria-label="Regenerate response"
              data-tooltip={streaming ? "Wait for the response to finish" : "Regenerate"}
              disabled={!!streaming}
              onClick={() => regenerate(conversationId, message.id)}
            >
              <Icon name="refresh" size={15} />
            </button>
          )}
          {usage?.completion != null && (
            <span
              className="msg-usage"
              title={`Prompt ${usage.prompt ?? "?"} tokens · Output ${usage.completion} tokens${usage.reasoning ? ` (${usage.reasoning} thinking)` : ""}${message.maxTokens ? ` · limit ${message.maxTokens.toLocaleString()}` : ""}`}
            >
              {usage.completion.toLocaleString()} tokens
              {usage.reasoning ? ` · ${usage.reasoning.toLocaleString()} thinking` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export const MessageItem = memo(function MessageItem({ message, conversationId, isLast }: { message: Message; conversationId: string; isLast: boolean }) {
  return message.role === "user" ? (
    <UserMessage message={message} conversationId={conversationId} />
  ) : (
    <AssistantMessage message={message} conversationId={conversationId} isLast={isLast} />
  );
});
