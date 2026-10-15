// Career Guidance Factory: the profile form, and a roadmap's four agent results as they stream.
import { useEffect, useRef, type FormEvent } from "react";
import { AGENTS, EMPTY_PROFILE, EXAMPLE_PROFILE, linksFor, PROFILE_FIELDS, resumeIndex, splitAgentOutput, type AgentInfo } from "../lib/career";
import { conversationToMarkdown } from "../lib/export";
import { downloadFile, formatDuration, safeFileName } from "../lib/util";
import { useCareer } from "../state/career";
import { useConversations } from "../state/conversations";
import { useServer } from "../state/server";
import { useToast } from "../state/toast";
import type { AgentId, AgentRun, AgentStatus, CareerProfile, Conversation } from "../types";
import { Icon, type IconName } from "./Icon";
import { Markdown } from "./Markdown";
import { CopyButton, Reasoning } from "./Message";
import "./CareerView.css";

const AGENT_ICON: Record<AgentId, IconName> = { skills: "bolt", career: "target", learning: "cap", jobs: "briefcase" };

const STATUS_LABEL: Record<AgentStatus, string> = { pending: "Waiting", running: "Working…", done: "Done", error: "Failed", stopped: "Stopped" };

export function CareerView() {
  const { active } = useConversations();
  return active?.career ? <Roadmap conversation={active} /> : <CareerForm />;
}

/** The four agents in order, as a numbered pipeline. With a run, each step shows its status. */
function Pipeline({ agents, live }: { agents?: Record<AgentId, AgentRun>; live?: boolean }) {
  return (
    <ol className="pipeline" aria-label="Agents">
      {AGENTS.map((a, i) => {
        const status = agents?.[a.id].status;
        return (
          <li key={a.id} className={`pipeline-step${status ? ` is-${status}` : ""}${status === "running" && live ? " is-live" : ""}`}>
            <span className="pipeline-icon" aria-hidden="true">
              <Icon name={status === "done" ? "check" : status === "error" ? "alert" : AGENT_ICON[a.id]} size={16} />
            </span>
            <span className="pipeline-text">
              <span className="pipeline-name">
                {i + 1}. {a.name}
              </span>
              <span className="pipeline-role">{status ? STATUS_LABEL[status === "running" && !live ? "stopped" : status] : a.role}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const FIELD_UI: Record<keyof CareerProfile, { hint: string; placeholder: string; rows?: number }> = {
  skills: { hint: "Technical and soft skills, tools, languages. Required.", placeholder: "e.g. Python, Java, SQL, data structures, Git, public speaking", rows: 3 },
  interests: { hint: "Topics, industries or kinds of work you enjoy.", placeholder: "e.g. AI, data, web development, design", rows: 2 },
  education: { hint: "Degree, year level, projects, work or internships.", placeholder: "e.g. 3rd-year BS Computer Science student", rows: 2 },
  goals: { hint: "What you want in the next few years.", placeholder: "e.g. Land an internship next year and become a machine learning engineer", rows: 2 },
  location: { hint: "Optional. Used for job searches.", placeholder: "e.g. Manila, Philippines, or Remote" },
};

function CareerForm() {
  const { draft, setDraft, start, running } = useCareer();
  const { activeModel, health } = useServer();
  const toast = useToast();
  const blocked = health === "missing_key" || health === "auth_failed" || health === "unreachable";
  const canSubmit = Boolean(draft.skills.trim() && activeModel && !running);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (running) return toast("A roadmap is already being generated. Wait for it or stop it first.", "error");
    if (!start(draft)) toast("Add your skills first.", "error");
  };

  return (
    <div className="career-scroll">
      <div className="career-inner">
        <div className="career-hero">
          <span className="career-hero-icon" aria-hidden="true">
            <Icon name="briefcase" size={24} />
          </span>
          <h1 className="career-title">Career Guidance Factory</h1>
          <p className="career-sub">Four AI agents work one after another to turn your skills and goals into a personalized career and learning roadmap.</p>
        </div>

        <Pipeline />

        {blocked && (
          <div className="career-alert" role="alert">
            <Icon name="alert" size={18} />
            <span>The AI service isn't available right now. Check the connection status at the bottom of the sidebar.</span>
          </div>
        )}

        <form className="career-form" onSubmit={submit}>
          <div className="career-form-head">
            <h2>Your profile</h2>
            <div className="career-form-tools">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(EXAMPLE_PROFILE)}>
                Use example
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDraft(EMPTY_PROFILE)} disabled={Object.values(draft).every((v) => !v)}>
                Clear
              </button>
            </div>
          </div>
          <div className="career-fields">
            {PROFILE_FIELDS.map((f) => {
              const ui = FIELD_UI[f.key];
              const id = `career-${f.key}`;
              const common = {
                id,
                value: draft[f.key],
                maxLength: f.max,
                placeholder: ui.placeholder,
                "aria-describedby": `${id}-hint`,
                required: f.key === "skills",
              };
              return (
                <div key={f.key} className={`career-field career-field-${f.key}`}>
                  <label htmlFor={id} className="career-label">
                    {f.label}
                    {f.key === "skills" && <span className="career-required"> *</span>}
                  </label>
                  {ui.rows ? (
                    <textarea {...common} className="textarea" rows={ui.rows} onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                  ) : (
                    <input {...common} className="input" type="text" onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
                  )}
                  <span id={`${id}-hint`} className="career-hint">
                    {ui.hint}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="career-submit">
            <p className="career-note">
              {activeModel ? (
                <>
                  The agents use <strong>{activeModel.label}</strong> (change it at the top). One roadmap counts as one message.
                </>
              ) : (
                "Loading available models…"
              )}
            </p>
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              <Icon name="spark" size={16} />
              Generate roadmap
            </button>
          </div>
        </form>
        <p className="career-disclaimer">AI can make mistakes. Check course and job details on the linked sites before relying on them.</p>
      </div>
    </div>
  );
}

function Roadmap({ conversation }: { conversation: Conversation }) {
  const run = conversation.career!;
  const { running, resume, stop, openForm } = useCareer();
  const { modelLabel } = useServer();
  const toast = useToast();
  const live = running === conversation.id;
  const next = resumeIndex(run);
  const current = AGENTS.find((a) => run.agents[a.id].status === "running")?.id;
  const cardRefs = useRef<Partial<Record<AgentId, HTMLElement | null>>>({});

  // Esc stops a run, as in chat.
  useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [live, stop]);

  // Bring each agent into view as it starts (once per agent, so reading isn't interrupted mid-text).
  useEffect(() => {
    if (live && current && current !== "skills") cardRefs.current[current]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [live, current]);

  const exportMarkdown = () => {
    downloadFile(`${safeFileName(conversation.title)}.md`, conversationToMarkdown(conversation, modelLabel), "text/markdown");
    toast("Exported as Markdown", "success");
  };
  const anyDone = AGENTS.some((a) => run.agents[a.id].status === "done");

  return (
    <div className="career-scroll">
      <div className="career-inner" aria-busy={live}>
        <header className="roadmap-head">
          <div className="career-kicker">
            <Icon name="briefcase" size={15} /> Career Guidance Factory
          </div>
          <h1 className="roadmap-title">{conversation.title}</h1>
          <dl className="profile-summary">
            {PROFILE_FIELDS.filter((f) => run.profile[f.key]).map((f) => (
              <div key={f.key}>
                <dt>{f.label}</dt>
                <dd>{run.profile[f.key]}</dd>
              </div>
            ))}
          </dl>
          <div className="roadmap-actions">
            {live ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={stop}>
                <Icon name="stop" size={14} /> Stop
              </button>
            ) : (
              next >= 0 && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => resume(conversation.id)} disabled={running !== null}>
                  <Icon name="refresh" size={14} /> {anyDone ? `Resume from ${AGENTS[next].name}` : "Try again"}
                </button>
              )
            )}
            <button type="button" className="btn btn-secondary btn-sm" onClick={exportMarkdown} disabled={!anyDone}>
              <Icon name="download" size={14} /> Export
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => openForm(run.profile)}>
              <Icon name="pencil" size={14} /> Adjust profile
            </button>
          </div>
        </header>

        <Pipeline agents={run.agents} live={live} />

        {AGENTS.map((a, i) => (
          <AgentCard
            key={a.id}
            ref={(el) => {
              cardRefs.current[a.id] = el;
            }}
            info={a}
            index={i}
            result={run.agents[a.id]}
            live={live}
            profile={run.profile}
            canRetry={!running && next === i}
            onRetry={() => resume(conversation.id)}
          />
        ))}
      </div>
    </div>
  );
}

function AgentCard({
  info,
  index,
  result,
  live,
  profile,
  canRetry,
  onRetry,
  ref,
}: {
  info: AgentInfo;
  index: number;
  result: AgentRun;
  live: boolean;
  profile: CareerProfile;
  canRetry: boolean;
  onRetry: () => void;
  ref: (el: HTMLElement | null) => void;
}) {
  const { modelLabel } = useServer();
  const { body, items } = splitAgentOutput(result.content);
  const streaming = live && result.status === "running";
  const status: AgentStatus = result.status === "running" && !live ? "stopped" : result.status;
  const links = result.status === "done" ? linksFor(info.id, items, profile) : null;
  const headingId = `agent-${info.id}`;

  return (
    <section ref={ref} className={`agent-card is-${status}`} aria-labelledby={headingId}>
      <header className="agent-head">
        <span className="agent-icon" aria-hidden="true">
          <Icon name={AGENT_ICON[info.id]} size={18} />
        </span>
        <div className="agent-heading">
          <h2 id={headingId}>
            {index + 1}. {info.title}
          </h2>
          <p className="agent-role">
            {info.name} · {info.role}
          </p>
        </div>
        <span className={`agent-status is-${status}`}>{STATUS_LABEL[status]}</span>
      </header>

      {status === "pending" ? (
        <p className="agent-wait">{index ? `Starts when the ${AGENTS[index - 1].name} is done.` : "Starts first."}</p>
      ) : (
        <div className="agent-body">
          {result.notice && streaming && <p className="agent-wait">{result.notice}</p>}
          {result.reasoning && <Reasoning text={result.reasoning} ms={result.reasoningMs} active={streaming && !body} />}
          {streaming && !body && !result.reasoning && (
            <p className="agent-wait">
              <span className="typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {result.model ? `${modelLabel(result.model)} is working…` : "Starting…"}
            </p>
          )}
          {body && <Markdown text={body} streaming={streaming} />}
          {result.status === "done" && result.finishReason === "length" && <p className="agent-wait">This part reached the output limit and may be cut off.</p>}

          {links && (
            <div className="agent-links">
              <h3>
                <Icon name="external" size={15} /> {links.label}
              </h3>
              <ul>
                {links.rows.map((row) => (
                  <li key={row.item}>
                    <span className="agent-link-item">{row.item}</span>
                    <span className="agent-link-sites">
                      {row.links.map((l) => (
                        <a key={l.site} href={l.url} target="_blank" rel="noopener noreferrer" className="agent-link" aria-label={`Search ${l.site} for ${row.item}`}>
                          {l.site}
                        </a>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(status === "error" || status === "stopped") && (
            <div className={`agent-problem${status === "error" ? " is-error" : ""}`} role={status === "error" ? "alert" : undefined}>
              <Icon name={status === "error" ? "alert" : "info"} size={16} />
              <span>{status === "error" ? result.error : "Stopped before this agent finished."}</span>
              {canRetry && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
                  <Icon name="refresh" size={14} /> {status === "error" ? "Retry from here" : "Resume"}
                </button>
              )}
            </div>
          )}

          {result.status === "done" && (
            <footer className="agent-foot">
              <CopyButton text={body} label={`Copy ${info.title.toLowerCase()}`} />
              <span>
                {modelLabel(result.model)}
                {result.reasoningMs ? ` · thought for ${formatDuration(result.reasoningMs)}` : ""}
                {result.usage?.completion ? ` · ${result.usage.completion.toLocaleString()} tokens` : ""}
              </span>
              {result.route && result.route.fallbackFrom.length > 0 && <span className="agent-fallback">{result.route.reason}</span>}
            </footer>
          )}
        </div>
      )}
    </section>
  );
}
