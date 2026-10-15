import { useCallback, useEffect, useRef, useState } from "react";
import { modKey } from "../lib/util";
import { useChat } from "../state/chat";
import { useServer } from "../state/server";
import { useSettings } from "../state/settings";
import type { ModelInfo } from "../types";
import { Icon } from "./Icon";
import { focusFirstItem, menuKeyDown, Popover } from "./ui/Popover";
import "./Header.css";

const REASONING_BADGE: Record<ModelInfo["reasoning"], string | null> = {
  toggle: "Thinking",
  always: "Always thinks",
  none: null,
};

/** Models grouped by provider, in the server's order. */
function groupByProvider(models: ModelInfo[]): [string, ModelInfo[]][] {
  const groups = new Map<string, ModelInfo[]>();
  for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return [...groups];
}

function ModelPicker() {
  const { models, modelsStatus, modelsError, reloadModels, activeModel } = useServer();
  const { update } = useSettings();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (open) focusFirstItem(listRef.current, '[aria-checked="true"]');
  }, [open]);

  const multipleProviders = new Set(models.map((m) => m.provider)).size > 1;

  if (modelsStatus === "loading") {
    return (
      <div className="model-trigger is-loading" aria-label="Loading models" role="status">
        <span className="skeleton" style={{ width: 132, height: 14 }} />
      </div>
    );
  }
  if (modelsStatus === "error" || !activeModel) {
    return (
      <button type="button" className="model-trigger is-error" onClick={reloadModels} title={modelsError ?? undefined}>
        <Icon name="alert" size={16} />
        <span>Models unavailable</span>
        <span className="model-retry">Retry</span>
      </button>
    );
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="model-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model: ${activeModel.label}. Change model`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-name">{activeModel.label}</span>
        <Icon name="chevronDown" size={16} className="model-chevron" />
      </button>
      <Popover open={open} onClose={close} anchorRef={anchorRef} width={340} className="model-popover">
        <div className="model-menu-head">Model</div>
        <div ref={listRef} role="menu" aria-label="Choose a model" className="menu" onKeyDown={menuKeyDown}>
          {groupByProvider(models).map(([provider, group]) => (
            <div key={provider} role="group" aria-label={provider}>
              <div className="model-group-head" aria-hidden="true">
                {multipleProviders ? provider : "Choose a model"}
              </div>
              {group.map((m) => {
                const selected = m.id === activeModel.id;
                const badge = REASONING_BADGE[m.reasoning];
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    className="model-option"
                    onClick={() => {
                      update({ model: m.id });
                      setOpen(false);
                      anchorRef.current?.focus();
                    }}
                  >
                    <span className="model-option-main">
                      <span className="model-option-title">
                        {m.label}
                        <span className="model-vendor">{m.vendor}</span>
                        {badge && <span className="model-badge">{badge}</span>}
                        {m.status === "cooling" && (
                          <span className="model-badge model-badge-busy" title="Recently failed or rate-limited; it may be slow or unavailable for a few minutes.">
                            Busy
                          </span>
                        )}
                      </span>
                      <span className="model-option-desc">{m.description}</span>
                    </span>
                    <span className="model-check" aria-hidden="true">
                      {selected && <Icon name="check" size={16} />}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <p className="model-menu-foot">Applies to your next message.</p>
      </Popover>
    </>
  );
}

export function Header({
  showSidebarButton,
  onOpenSidebar,
  panelOpen,
  onTogglePanel,
}: {
  showSidebarButton: boolean;
  onOpenSidebar: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const { newChat } = useChat();
  return (
    <header className="header">
      {showSidebarButton && (
        <button type="button" className="icon-btn" onClick={onOpenSidebar} aria-label="Open sidebar">
          <Icon name="menu" />
        </button>
      )}
      <ModelPicker />
      <div className="header-spacer" />
      {showSidebarButton && (
        <button type="button" className="icon-btn" onClick={newChat} aria-label="New chat" data-tooltip="New chat" data-tooltip-align="end">
          <Icon name="compose" />
        </button>
      )}
      <button
        type="button"
        className="icon-btn"
        onClick={onTogglePanel}
        aria-label="Generation settings"
        aria-expanded={panelOpen}
        aria-controls={panelOpen ? "control-panel" : undefined}
        data-tooltip={`Generation settings (${modKey}+.)`}
        data-tooltip-align="end"
      >
        <Icon name="sliders" />
      </button>
    </header>
  );
}
