import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { downloadFile, modKey } from "../lib/util";
import { useChat } from "../state/chat";
import { useConversations } from "../state/conversations";
import { useServer } from "../state/server";
import { useSettings } from "../state/settings";
import { useToast } from "../state/toast";
import { Icon, type IconName } from "./Icon";
import { Segmented, Switch } from "./ui/controls";
import { Dialog, useConfirm } from "./ui/Dialog";
import "./SettingsDialog.css";

type Tab = "appearance" | "chat" | "data" | "shortcuts";
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "appearance", label: "Appearance", icon: "palette" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "data", label: "Data & API", icon: "database" },
  { id: "shortcuts", label: "Shortcuts", icon: "keyboard" },
];

function Row({ label, description, children }: { label: string; description?: string; children?: ReactNode }) {
  return (
    <div className="field-row">
      <div className="field-text">
        <span className="field-label">{label}</span>
        {description && <p className="field-desc">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("appearance");
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (i + delta + TABS.length) % TABS.length;
    setTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  return (
    <Dialog open={open} onClose={onClose} title="Settings" className="settings-dialog">
      <div className="settings">
        <div className="settings-tabs" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
          {TABS.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`settings-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`settings-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className="settings-tab"
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              <Icon name={t.icon} size={16} />
              {t.label}
            </button>
          ))}
        </div>
        <div className="settings-panel" role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`}>
          {tab === "appearance" && <AppearanceTab />}
          {tab === "chat" && <ChatTab />}
          {tab === "data" && <DataTab />}
          {tab === "shortcuts" && <ShortcutsTab />}
        </div>
      </div>
    </Dialog>
  );
}

function AppearanceTab() {
  const { settings, update } = useSettings();
  return (
    <>
      <Row label="Theme" description="Black uses true black for OLED displays. White + Gold is the light theme.">
        <Segmented
          label="Theme"
          value={settings.theme}
          onChange={(theme) => update({ theme })}
          options={[
            { value: "dark", label: "Dark" },
            { value: "black", label: "Black" },
            { value: "light", label: "White + Gold" },
          ]}
        />
      </Row>
      <Row label="Message text size">
        <Segmented
          label="Message text size"
          value={settings.fontSize}
          onChange={(fontSize) => update({ fontSize })}
          options={[
            { value: "small", label: "S" },
            { value: "medium", label: "M" },
            { value: "large", label: "L" },
          ]}
        />
      </Row>
      <Row label="Chat width" description="Wide gives code and tables more room.">
        <Segmented
          label="Chat width"
          value={settings.chatWidth}
          onChange={(chatWidth) => update({ chatWidth })}
          options={[
            { value: "standard", label: "Standard" },
            { value: "wide", label: "Wide" },
          ]}
        />
      </Row>
    </>
  );
}

function ChatTab() {
  const { settings, update } = useSettings();
  return (
    <>
      <Switch
        label="Enter to send"
        description={settings.sendOnEnter ? "Shift+Enter inserts a new line." : `Use ${modKey}+Enter to send; Enter inserts a new line.`}
        checked={settings.sendOnEnter}
        onChange={(sendOnEnter) => update({ sendOnEnter })}
      />
      <Switch
        label="Fall back if my chosen model fails"
        description="When your chosen model is busy or unavailable, let another available model answer instead of showing an error. Off by default."
        checked={settings.manualFallback}
        onChange={(manualFallback) => update({ manualFallback })}
      />
      <Switch
        label="Show routing details"
        description="Developer view: under each reply, show how the router classified the message, which models it considered and why it chose one."
        checked={settings.showRouting}
        onChange={(showRouting) => update({ showRouting })}
      />
      <Switch
        label="Expand thinking by default"
        description="Show the model's reasoning open after it finishes, instead of collapsed."
        checked={settings.expandReasoning}
        onChange={(expandReasoning) => update({ expandReasoning })}
      />
    </>
  );
}

function DataTab() {
  const { conversations, dispatch } = useConversations();
  const { streaming, stop } = useChat();
  const { health, healthMessage, recheckHealth, models, limits } = useServer();
  const confirm = useConfirm();
  const toast = useToast();

  return (
    <>
      <Row
        label="Public demo"
        description={
          limits
            ? `Open to anyone with the link. Messages are rate limited per visitor${limits.rateLimitScope === "global" ? " across all servers" : " (per server instance)"}, and one response can run for up to ${Math.round(limits.streamSeconds / 60)} minutes. Chats are stored only in this browser.`
            : "Open to anyone with the link. Chats are stored only in this browser."
        }
      />
      <Row label="API connection" description={healthMessage}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={recheckHealth} disabled={health === "checking"}>
          <Icon name="refresh" size={14} />
          {health === "checking" ? "Checking…" : "Re-check"}
        </button>
      </Row>
      <Row label="Providers" description={`${[...new Set(models.map((m) => m.provider))].join(" and ")} · ${models.length} models, discovered from the providers' live catalogs. You choose the model. API keys stay on the server and are never sent to this browser.`} />
      <Row label="Export conversations" description={`Download all ${conversations.length} conversations as JSON.`}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={conversations.length === 0}
          onClick={() => {
            downloadFile(`prometheus-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(conversations, null, 2), "application/json");
            toast("Export downloaded", "success");
          }}
        >
          <Icon name="download" size={14} />
          Export
        </button>
      </Row>
      <Row label="Delete all conversations" description="Permanently removes every chat stored in this browser.">
        <button
          type="button"
          className="btn btn-sm settings-danger"
          disabled={conversations.length === 0}
          onClick={async () => {
            const ok = await confirm({
              title: "Delete all conversations?",
              message: `All ${conversations.length} conversations will be permanently removed from this browser. This can't be undone.`,
              confirmLabel: "Delete all",
              danger: true,
            });
            if (!ok) return;
            if (streaming) stop();
            dispatch({ type: "clear" });
            toast("All conversations deleted");
          }}
        >
          <Icon name="trash" size={14} />
          Delete all
        </button>
      </Row>
    </>
  );
}

function ShortcutsTab() {
  const shortcuts: [string, string[]][] = [
    ["New chat", [modKey, "Shift", "O"]],
    ["Search chats", [modKey, "K"]],
    ["Toggle sidebar", [modKey, "B"]],
    ["Generation settings", [modKey, "."]],
    ["Send message", ["Enter"]],
    ["New line", ["Shift", "Enter"]],
    ["Stop generating", ["Esc"]],
  ];
  return (
    <ul className="shortcuts">
      {shortcuts.map(([label, keys]) => (
        <li key={label}>
          <span>{label}</span>
          <span className="shortcut-keys">
            {keys.map((k) => (
              <kbd key={k}>{k}</kbd>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
