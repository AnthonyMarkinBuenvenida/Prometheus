import { useServer } from "../state/server";
import { GENERATION_DEFAULTS, useSettings } from "../state/settings";
import { Icon } from "./Icon";
import { Slider, Switch } from "./ui/controls";
import "./ControlPanel.css";

const MAX_SYSTEM_CHARS = 8000; // mirrors server/api.mjs
const OUTPUT_STEP = 1000;
const OUTPUT_PRESETS = [4_000, 8_000, 16_000, 32_000, 50_000];

const short = (n: number) => `${Math.round(n / 1000)}K`;

export function ControlPanel({ open, overlay, onClose }: { open: boolean; overlay: boolean; onClose: () => void }) {
  const { settings, update } = useSettings();
  const { activeModel, limits } = useServer();
  if (!open && !overlay) return null;

  // The server reports min(300K app cap, verified model maximum); never offer more than that.
  const maxOut = activeModel?.maxOutput ?? 8_000;
  const maxTokens = Math.min(settings.maxTokens, maxOut);
  const presets = OUTPUT_PRESETS.filter((p) => p <= maxOut);
  if (!presets.includes(maxOut)) presets.push(maxOut);
  const outputHint = [
    activeModel?.contextWindow
      ? `Up to ${maxOut.toLocaleString()} for this model; shares a ${activeModel.contextWindow.toLocaleString()}-token context with the conversation.`
      : `Up to ${maxOut.toLocaleString()} for this model. Includes thinking.`,
    limits ? `One response can run for about ${Math.round(limits.streamSeconds / 60)} min here; long outputs can be continued.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const isDefault = (Object.keys(GENERATION_DEFAULTS) as (keyof typeof GENERATION_DEFAULTS)[]).every((k) => settings[k] === GENERATION_DEFAULTS[k]);
  const reasoning = activeModel?.reasoning;

  return (
    <aside
      id="control-panel"
      className={`panel${overlay ? " panel-overlay" : ""}${open ? " is-open" : ""}`}
      aria-label="Generation settings"
      inert={!open}
    >
      <header className="panel-header">
        <h2 className="panel-title">Generation</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close generation settings">
          <Icon name="x" />
        </button>
      </header>

      <div className="panel-body">
        {activeModel && (
          <div className="panel-model">
            <span className="panel-model-label">{activeModel.label}</span>
            <span className="panel-model-meta">
              {activeModel.vendor} · up to {activeModel.maxOutput.toLocaleString()} output tokens
            </span>
          </div>
        )}

        <section className="panel-section">
          <Switch
            label="Thinking"
            description="Reason step by step before answering. Slower, but often better on hard problems."
            checked={reasoning === "toggle" ? settings.thinking : reasoning === "always"}
            onChange={(v) => update({ thinking: v })}
            disabled={reasoning !== "toggle"}
            disabledReason={reasoning === "always" ? "This model always thinks; it can't be turned off." : "This model doesn't support a thinking mode."}
          />
        </section>

        <section className="panel-section">
          <Slider
            label="Temperature"
            value={settings.temperature}
            min={0}
            max={1.5}
            step={0.05}
            format={(v) => v.toFixed(2)}
            onChange={(v) => update({ temperature: v })}
            hint="Lower is focused and repeatable; higher is more varied."
          />
          <Slider label="Top P" value={settings.topP} min={0.05} max={1} step={0.05} format={(v) => v.toFixed(2)} onChange={(v) => update({ topP: v })} hint="Limits sampling to the most likely tokens." />
          <Slider
            label="Max output"
            value={maxTokens}
            min={OUTPUT_STEP}
            max={maxOut}
            step={OUTPUT_STEP}
            format={(v) => `${v.toLocaleString()} tokens`}
            onChange={(v) => update({ maxTokens: v })}
            hint={outputHint}
          />
          <div className="token-presets" role="group" aria-label="Max output presets">
            {presets.map((p) => (
              <button key={p} type="button" className="token-preset" aria-pressed={maxTokens === p} aria-label={`${p.toLocaleString()} tokens`} onClick={() => update({ maxTokens: p })}>
                {short(p)}
              </button>
            ))}
          </div>
        </section>

        <section className="panel-section">
          <div className="panel-field-head">
            <label htmlFor="system-prompt" className="field-label">
              System prompt
            </label>
            <span className="panel-count">
              {settings.systemPrompt.length.toLocaleString()} / {MAX_SYSTEM_CHARS.toLocaleString()}
            </span>
          </div>
          <textarea
            id="system-prompt"
            className="textarea panel-textarea"
            rows={5}
            maxLength={MAX_SYSTEM_CHARS}
            placeholder="e.g. You are a concise senior engineer. Prefer code over prose."
            value={settings.systemPrompt}
            onChange={(e) => update({ systemPrompt: e.target.value })}
          />
          <p className="field-desc">Sent at the start of every request.</p>
        </section>
      </div>

      <footer className="panel-footer">
        <span className="panel-note">Saved in this browser · applies to your next message</span>
        <button type="button" className="btn btn-ghost btn-sm" disabled={isDefault} onClick={() => update({ ...GENERATION_DEFAULTS })}>
          <Icon name="refresh" size={14} />
          Reset
        </button>
      </footer>
    </aside>
  );
}
