import { useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { MAX_FILE_BYTES, MAX_FILES, readTextFile } from "../lib/files";
import { formatBytes, modKey } from "../lib/util";
import { useChat } from "../state/chat";
import { useDraftActions, useDraftValue } from "../state/draft";
import { useServer } from "../state/server";
import { useSettings } from "../state/settings";
import { useToast } from "../state/toast";
import type { AttachedFile } from "../types";
import { Icon } from "./Icon";
import "./Composer.css";

export function Composer() {
  const { send, stop, streaming } = useChat();
  const draft = useDraftValue();
  const { setDraft, composerRef } = useDraftActions();
  const { activeModel, health, modelsStatus } = useServer();
  const { settings, update } = useSettings();
  const toast = useToast();
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-grow the textarea up to a cap, then scroll inside it.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.max(160, window.innerHeight * 0.4))}px`;
  }, [draft, composerRef]);

  const blockedReason =
    modelsStatus === "error"
      ? "Models couldn't be loaded"
      : health === "missing_key"
        ? "The server has no API key configured"
        : health === "auth_failed"
          ? "The server's API key was rejected"
          : null;
  const hasInput = draft.trim().length > 0 || files.length > 0;
  const canSend = hasInput && !streaming && !blockedReason && !!activeModel;

  const submit = () => {
    if (!canSend) return;
    if (send(draft, files)) {
      setDraft("");
      setFiles([]);
    }
  };

  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const next = [...files];
    for (const file of Array.from(list)) {
      if (next.length >= MAX_FILES) {
        toast(`You can attach up to ${MAX_FILES} files per message.`, "error");
        break;
      }
      try {
        const read = await readTextFile(file);
        const existing = next.findIndex((f) => f.name === read.name);
        if (existing >= 0) next[existing] = read;
        else next.push(read);
      } catch (err) {
        toast((err as Error).message, "error");
      }
    }
    setFiles(next);
    composerRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (settings.sendOnEnter && !e.shiftKey))) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && streaming) {
      e.preventDefault();
      stop();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!streaming) void addFiles(e.dataTransfer.files);
  };

  const placeholder = blockedReason ? `${blockedReason}. Check the status in the sidebar.` : activeModel ? `Message ${activeModel.label}` : "Loading models…";

  return (
    <div className="composer-wrap">
      <form
        className={`composer${dragging ? " is-dragging" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        {files.length > 0 && (
          <ul className="composer-files" aria-label="Attached files">
            {files.map((f) => (
              <li key={f.name} className="composer-file">
                <Icon name="file" size={16} />
                <span className="composer-file-text">
                  <span className="composer-file-name">{f.name}</span>
                  <span className="composer-file-size">{formatBytes(f.size)}</span>
                </span>
                <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x !== f))}>
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <label htmlFor="composer" className="visually-hidden">
          Message
        </label>
        <textarea
          id="composer"
          ref={composerRef}
          className="composer-input"
          rows={1}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby="composer-hint"
        />

        <div className="composer-bar">
          <button
            type="button"
            className="icon-btn"
            aria-label="Attach text files"
            data-tooltip={`Attach text files (up to ${MAX_FILES}, ${formatBytes(MAX_FILE_BYTES)} each)`}
            data-tooltip-side="top"
            disabled={!!streaming || files.length >= MAX_FILES}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="paperclip" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(e.target.files);
              e.target.value = "";
            }}
          />

          {activeModel?.reasoning === "toggle" && (
            <button
              type="button"
              className="chip"
              aria-pressed={settings.thinking}
              onClick={() => update({ thinking: !settings.thinking })}
              data-tooltip={settings.thinking ? "Model reasons step by step before answering" : "Faster answers without a reasoning step"}
              data-tooltip-side="top"
            >
              <Icon name="spark" size={15} />
              Thinking
            </button>
          )}
          {activeModel?.reasoning === "always" && (
            <span className="chip chip-static" title={`${activeModel.label} always reasons before answering; it can't be turned off.`}>
              <Icon name="spark" size={15} />
              Thinking · always on
            </span>
          )}

          <div className="composer-spacer" />

          {streaming ? (
            <button type="button" className="send-btn is-stop" onClick={stop} aria-label="Stop generating" data-tooltip="Stop (Esc)" data-tooltip-side="top" data-tooltip-align="end">
              <Icon name="stop" size={16} />
            </button>
          ) : (
            <button
              type="submit"
              className="send-btn"
              disabled={!canSend}
              aria-label="Send message"
              data-tooltip={blockedReason ?? (hasInput ? "Send (Enter)" : "Type a message to send")}
              data-tooltip-side="top"
              data-tooltip-align="end"
            >
              <Icon name="arrowUp" size={18} />
            </button>
          )}
        </div>
        {dragging && (
          <div className="composer-drop" aria-hidden="true">
            <Icon name="paperclip" /> Drop text files to attach
          </div>
        )}
      </form>
      <p id="composer-hint" className="composer-hint">
        {settings.sendOnEnter ? "Enter to send · Shift+Enter for a new line" : `${modKey}+Enter to send`} · AI can make mistakes, so verify important details.
      </p>
    </div>
  );
}
