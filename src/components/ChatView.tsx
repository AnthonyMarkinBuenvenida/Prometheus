import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChat } from "../state/chat";
import { useDraftActions } from "../state/draft";
import { useConversations } from "../state/conversations";
import { useServer } from "../state/server";
import type { Conversation } from "../types";
import { Icon, Logo, type IconName } from "./Icon";
import { MessageItem } from "./Message";
import "./ChatView.css";

const SUGGESTIONS: { icon: IconName; title: string; prompt: string }[] = [
  { icon: "bolt", title: "Explain a concept", prompt: "Explain how transformers use attention, with a simple analogy and a small worked example." },
  { icon: "compose", title: "Draft a plan", prompt: "Draft a two-week launch plan for a small AI product, with milestones and owners." },
  { icon: "file", title: "Review code", prompt: "Review this function for bugs and readability, then suggest an improved version:\n\n" },
  { icon: "spark", title: "Brainstorm ideas", prompt: "Brainstorm 10 practical ways a small team could use AI agents to save time each week." },
];

function EmptyState() {
  const { setDraft, focusComposer } = useDraftActions();
  const { activeModel, health, healthMessage } = useServer();
  const blocked = health === "missing_key" || health === "auth_failed" || health === "unreachable";

  return (
    <div className="empty">
      <div className="empty-inner">
        <Logo size={48} />
        <h1 className="empty-title">What are we building today?</h1>
        <p className="empty-sub">
          {activeModel ? (
            <>
              <>
                You're chatting with <strong>{activeModel.label}</strong> via {activeModel.provider}.
              </>
            </>
          ) : (
            "Loading available models…"
          )}
        </p>

        {blocked && (
          <div className="empty-alert" role="alert">
            <Icon name="alert" size={18} />
            <div>
              <strong>{health === "unreachable" ? "Can't reach the AI service" : "API not configured"}</strong>
              <p>{healthMessage}</p>
            </div>
          </div>
        )}

        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button
              key={s.title}
              type="button"
              className="suggestion"
              onClick={() => {
                setDraft(s.prompt);
                focusComposer();
              }}
            >
              <Icon name={s.icon} size={18} />
              <span className="suggestion-title">{s.title}</span>
              <span className="suggestion-prompt">{s.prompt.trim()}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MessageList({ conversation }: { conversation: Conversation }) {
  const { streaming } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  };

  // Switching conversations always starts at the latest message.
  useEffect(() => {
    stickToBottom.current = true;
    scrollToBottom();
  }, [conversation.id]);

  // Follow streamed output only while the user hasn't scrolled up to read.
  useLayoutEffect(() => {
    if (stickToBottom.current) scrollToBottom();
  }, [conversation.messages]);

  const isStreamingHere = streaming?.conversationId === conversation.id;
  const lastIndex = conversation.messages.length - 1;

  return (
    <div className="messages-wrap">
      <div
        ref={scrollRef}
        className="messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
          stickToBottom.current = distance < 80;
          setShowJump(distance > 240);
        }}
      >
        <h1 className="visually-hidden">{conversation.title}</h1>
        <div className="messages-inner" role="log" aria-label={conversation.title} aria-busy={isStreamingHere}>
          {conversation.messages.map((m, i) => (
            <MessageItem key={m.id} message={m} conversationId={conversation.id} isLast={i === lastIndex} />
          ))}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          className="jump-bottom"
          aria-label="Scroll to latest message"
          onClick={() => {
            stickToBottom.current = true;
            scrollToBottom("smooth");
          }}
        >
          <Icon name="arrowDown" size={16} />
        </button>
      )}
    </div>
  );
}

export function ChatView() {
  const { active } = useConversations();
  return active && active.messages.length > 0 ? <MessageList conversation={active} /> : <EmptyState />;
}
