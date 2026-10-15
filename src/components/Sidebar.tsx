import { memo, useCallback, useDeferredValue, useMemo, useState, type RefObject } from "react";
import { careerSearchText } from "../lib/career";
import { conversationToMarkdown } from "../lib/export";
import { dateGroup, downloadFile, modKey, safeFileName, type DateGroup } from "../lib/util";
import { useCareer } from "../state/career";
import { useChat } from "../state/chat";
import { useDraftActions } from "../state/draft";
import { useConversationActions, useConversations } from "../state/conversations";
import { useServer } from "../state/server";
import { useToast } from "../state/toast";
import type { Conversation } from "../types";
import { Icon, Logo } from "./Icon";
import { useConfirm } from "./ui/Dialog";
import { ActionMenu } from "./ui/Popover";
import "./Sidebar.css";

type Mode = "expanded" | "rail" | "drawer";

interface SidebarProps {
  mode: Mode;
  open: boolean;
  onToggle: () => void;
  onNavigate: () => void;
  onOpenSettings: () => void;
  onSearch: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

const HEALTH_LABEL = {
  checking: "Checking…",
  ok: "Connected",
  missing_key: "API key missing",
  auth_failed: "API key rejected",
  unreachable: "API unreachable",
} as const;

function StatusButton({ compact }: { compact?: boolean }) {
  const { health, healthMessage, recheckHealth } = useServer();
  return (
    <button
      type="button"
      className={`status${compact ? " status-compact" : ""}`}
      data-status={health}
      onClick={recheckHealth}
      aria-label={`API status: ${HEALTH_LABEL[health]}. ${healthMessage} Click to re-check.`}
      data-tooltip={compact ? HEALTH_LABEL[health] : "Click to re-check"}
      data-tooltip-side={compact ? "right" : "top"}
    >
      <span className="status-dot" />
      {!compact && <span className="status-label">{HEALTH_LABEL[health]}</span>}
    </button>
  );
}

export function Sidebar({ mode, open, onToggle, onNavigate, onOpenSettings, onSearch, searchRef }: SidebarProps) {
  const { newChat } = useChat();
  const { openForm } = useCareer();
  const { focusComposer } = useDraftActions();
  const navigateFromList = useCallback(() => {
    onNavigate();
    // Skip on touch devices: focusing would pop the on-screen keyboard.
    if (window.matchMedia("(hover: hover)").matches) focusComposer();
  }, [onNavigate, focusComposer]);

  if (mode === "rail") {
    return (
      <aside className="rail" aria-label="Sidebar (collapsed)">
        <button type="button" className="icon-btn rail-logo" onClick={onToggle} aria-label="Expand sidebar" data-tooltip="Expand sidebar" data-tooltip-side="right">
          <Logo size={28} />
        </button>
        <button type="button" className="icon-btn" onClick={newChat} aria-label="New chat" data-tooltip={`New chat (${modKey}+Shift+O)`} data-tooltip-side="right">
          <Icon name="compose" />
        </button>
        <button type="button" className="icon-btn" onClick={() => openForm()} aria-label="Career Guidance" data-tooltip="Career Guidance" data-tooltip-side="right">
          <Icon name="briefcase" />
        </button>
        <button type="button" className="icon-btn" onClick={onSearch} aria-label="Search chats" data-tooltip={`Search (${modKey}+K)`} data-tooltip-side="right">
          <Icon name="search" />
        </button>
        <div className="rail-spacer" />
        <StatusButton compact />
        <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="Settings" data-tooltip="Settings" data-tooltip-side="right">
          <Icon name="settings" />
        </button>
      </aside>
    );
  }

  return (
    <aside className={`sidebar sidebar-${mode}${open ? " is-open" : ""}`} aria-label="Conversations" inert={mode === "drawer" && !open}>
      <div className="sidebar-top">
        <div className="brand">
          <Logo size={28} />
          <div className="brand-text">
            <span className="brand-name">Prometheus</span>
            <span className="brand-tag">AI Factory</span>
          </div>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={onToggle}
          aria-label={mode === "drawer" ? "Close sidebar" : "Collapse sidebar"}
          data-tooltip={mode === "drawer" ? "Close" : `Collapse (${modKey}+B)`}
          data-tooltip-align="end"
        >
          <Icon name={mode === "drawer" ? "x" : "sidebar"} />
        </button>
      </div>

      <button
        type="button"
        className="new-chat"
        onClick={() => {
          newChat();
          onNavigate();
        }}
      >
        <Icon name="compose" size={17} />
        <span>New chat</span>
        <span className="new-chat-kbd" aria-hidden="true">
          <kbd>{modKey}</kbd>
          <kbd>⇧</kbd>
          <kbd>O</kbd>
        </span>
      </button>

      <CareerNav
        onOpen={() => {
          openForm();
          onNavigate();
        }}
      />

      <ConversationList searchRef={searchRef} onNavigate={navigateFromList} />

      <div className="sidebar-footer">
        <StatusButton />
        <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="Settings" data-tooltip="Settings" data-tooltip-side="top" data-tooltip-align="end">
          <Icon name="settings" />
        </button>
      </div>
    </aside>
  );
}

/** Entry to the Career Guidance Factory form; highlighted while the form is open. */
function CareerNav({ onOpen }: { onOpen: () => void }) {
  const { careerForm } = useConversations();
  return (
    <button type="button" className={`career-nav${careerForm ? " is-active" : ""}`} aria-current={careerForm ? "page" : undefined} onClick={onOpen}>
      <Icon name="briefcase" size={17} />
      <span>Career Guidance</span>
    </button>
  );
}

const GROUP_ORDER: DateGroup[] = ["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

function ConversationList({ searchRef, onNavigate }: { searchRef: RefObject<HTMLInputElement | null>; onNavigate: () => void }) {
  const { conversations: live, activeId } = useConversations();
  const { streaming } = useChat();
  const { running } = useCareer();
  const [query, setQuery] = useState("");
  // Streaming updates the list ~60x/s; grouping and (when searching) full-text matching run at
  // lower priority so they never delay typing or the message view.
  const conversations = useDeferredValue(live);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? conversations.filter((c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)) || careerSearchText(c).includes(q))
      : conversations;
    const byGroup = new Map<DateGroup, Conversation[]>();
    for (const c of matches) {
      const g = dateGroup(c.updatedAt);
      byGroup.set(g, [...(byGroup.get(g) ?? []), c]);
    }
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({ label: g, items: byGroup.get(g)! }));
  }, [conversations, query]);

  return (
    <>
      <div className="sidebar-search">
        <Icon name="search" size={16} />
        <input
          ref={searchRef}
          type="search"
          className="sidebar-search-input"
          placeholder="Search chats"
          aria-label="Search conversations"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
        />
        {query ? (
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Clear search" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>
            <Icon name="x" size={14} />
          </button>
        ) : (
          <span className="search-kbd" aria-hidden="true">
            <kbd>{modKey}</kbd>
            <kbd>K</kbd>
          </span>
        )}
      </div>

      <nav className="conv-list" aria-label="Recent conversations">
        {conversations.length === 0 ? (
          <div className="conv-empty">
            <Icon name="chat" size={20} />
            <p>No conversations yet</p>
            <span>Your chats are saved in this browser.</span>
          </div>
        ) : groups.length === 0 ? (
          <div className="conv-empty">
            <Icon name="search" size={20} />
            <p>No matches</p>
            <span>Nothing matches “{query.trim()}”.</span>
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.label} className="conv-group">
              <h3 className="conv-group-label">{g.label}</h3>
              <ul>
                {g.items.map((c) => (
                  <ConversationItem key={c.id} conversation={c} active={c.id === activeId} live={streaming?.conversationId === c.id || running === c.id} onNavigate={onNavigate} />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>
    </>
  );
}

const ConversationItem = memo(function ConversationItem({
  conversation,
  active,
  live,
  onNavigate,
}: {
  conversation: Conversation;
  active: boolean;
  live: boolean;
  onNavigate: () => void;
}) {
  const { dispatch } = useConversationActions();
  const { stop: stopChat } = useChat();
  const { stop: stopCareer } = useCareer();
  const { modelLabel } = useServer();
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  const commitRename = (value: string) => {
    const title = value.trim();
    if (title && title !== conversation.title) dispatch({ type: "rename", id: conversation.id, title });
    setEditing(false);
  };

  const remove = async () => {
    const ok = await confirm({
      title: "Delete conversation?",
      message: `“${conversation.title}” will be permanently removed from this browser.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    if (live) (conversation.kind === "career" ? stopCareer : stopChat)();
    dispatch({ type: "delete", id: conversation.id });
    toast("Conversation deleted");
  };

  return (
    <li className={`conv-item${active ? " is-active" : ""}`}>
      {editing ? (
        <input
          className="conv-rename"
          defaultValue={conversation.title}
          aria-label="Conversation title"
          autoFocus
          maxLength={120}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => commitRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename(e.currentTarget.value);
            if (e.key === "Escape") {
              e.stopPropagation();
              setEditing(false);
            }
          }}
        />
      ) : (
        <>
          <button
            type="button"
            className="conv-link"
            aria-current={active ? "page" : undefined}
            onClick={() => {
              dispatch({ type: "select", id: conversation.id });
              onNavigate();
            }}
            onDoubleClick={() => setEditing(true)}
          >
            {live && <span className="conv-live" aria-label="Generating" />}
            {conversation.kind === "career" && !live && <Icon name="briefcase" size={14} className="conv-kind" />}
            <span className="conv-title">{conversation.title}</span>
          </button>
          <ActionMenu
            label={`Options for ${conversation.title}`}
            items={[
              { label: "Rename", icon: "pencil", onSelect: () => setEditing(true) },
              {
                label: "Export Markdown",
                icon: "download",
                onSelect: () => {
                  downloadFile(`${safeFileName(conversation.title)}.md`, conversationToMarkdown(conversation, modelLabel), "text/markdown");
                  toast("Exported as Markdown", "success");
                },
              },
              { label: "Delete", icon: "trash", danger: true, onSelect: remove },
            ]}
            triggerClassName="icon-btn icon-btn-sm conv-menu"
          />
        </>
      )}
    </li>
  );
});
