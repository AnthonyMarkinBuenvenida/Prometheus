// Career Guidance Factory: agent descriptions, run state helpers, search links and export.
// Pure (no React) so it can be unit-tested. The agents themselves run on the server (server/career.mjs).
import type { AgentId, AgentRun, CareerProfile, CareerRun, Conversation } from "../types";

export interface AgentInfo {
  id: AgentId;
  name: string;
  /** What the agent does, for the UI. */
  role: string;
  /** Heading of its section in the roadmap. */
  title: string;
}

/** In the order the server runs them. */
export const AGENTS: AgentInfo[] = [
  { id: "skills", name: "Skills Agent", role: "Evaluates your skills", title: "Skills evaluation" },
  { id: "career", name: "Career Agent", role: "Recommends careers", title: "Career recommendations" },
  { id: "learning", name: "Learning Agent", role: "Suggests courses and a learning plan", title: "Learning roadmap" },
  { id: "jobs", name: "Job Matching Agent", role: "Identifies suitable opportunities", title: "Job opportunities" },
];

export const PROFILE_FIELDS: { key: keyof CareerProfile; label: string; max: number }[] = [
  { key: "skills", label: "Skills", max: 3000 },
  { key: "interests", label: "Interests", max: 2000 },
  { key: "education", label: "Education and experience", max: 1000 },
  { key: "goals", label: "Career goals", max: 2000 },
  { key: "location", label: "Location", max: 120 },
];

export const EMPTY_PROFILE: CareerProfile = { skills: "", interests: "", education: "", goals: "", location: "" };

/** The example from the feature brief: a Computer Science student. */
export const EXAMPLE_PROFILE: CareerProfile = {
  skills: "Python, Java, SQL, data structures and algorithms, Git, basic HTML/CSS/JavaScript, teamwork, presenting",
  interests: "Artificial intelligence, data, building web apps, solving puzzles",
  education: "3rd-year BS Computer Science student; built a class project web app and a small machine-learning model",
  goals: "Get an internship next year and become a machine learning engineer within 3 years",
  location: "Manila, Philippines (open to remote)",
};

export function newRun(profile: CareerProfile): CareerRun {
  const agents = Object.fromEntries(AGENTS.map((a) => [a.id, { status: "pending", content: "" } satisfies AgentRun])) as Record<AgentId, AgentRun>;
  return { profile, agents };
}

/** Sidebar title, e.g. "Roadmap: Get an internship next year and become…". */
export function careerTitle(profile: CareerProfile): string {
  const basis = (profile.goals || profile.education || profile.skills).replace(/\s+/g, " ").trim();
  if (!basis) return "Career roadmap";
  const title = `Roadmap: ${basis}`;
  return title.length > 52 ? `${title.slice(0, 50).trimEnd()}…` : title;
}

/** Index of the first agent without a finished result (where a run resumes), or -1 when all are done. */
export function resumeIndex(run: CareerRun): number {
  return AGENTS.findIndex((a) => run.agents[a.id].status !== "done");
}

/** A run interrupted by a reload can never finish: its running agent becomes "stopped". */
export function settleRun(run: CareerRun): CareerRun {
  if (!AGENTS.some((a) => run.agents[a.id].status === "running")) return run;
  const agents = { ...run.agents };
  for (const a of AGENTS) if (agents[a.id].status === "running") agents[a.id] = { ...agents[a.id], status: "stopped" };
  return { ...run, agents };
}

/**
 * Splits an agent's Markdown from the JSON block of names it ends with (Learning and Job Matching
 * agents). While streaming, everything from the block's opening fence is hidden. Items are cleaned:
 * strings only, trimmed, at most 80 characters, no duplicates, at most 8.
 */
export function splitAgentOutput(text: string): { body: string; items: string[] } {
  const start = [...text.matchAll(/```[ \t]*json/gi)].at(-1)?.index ?? -1;
  if (start < 0) return { body: text, items: [] };
  const body = text.slice(0, start).trimEnd();
  const block = text.slice(start).replace(/^```[ \t]*json[^\n]*\n?/i, "");
  const end = block.indexOf("```");
  if (end < 0) return { body, items: [] }; // still streaming
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.slice(0, end));
  } catch {
    return { body, items: [] };
  }
  const list = parsed && typeof parsed === "object" ? Object.values(parsed as Record<string, unknown>).find(Array.isArray) : null;
  const items: string[] = [];
  for (const v of list ?? []) {
    if (typeof v !== "string") continue;
    const t = v.replace(/\s+/g, " ").trim();
    if (t && t.length <= 80 && !items.some((x) => x.toLowerCase() === t.toLowerCase())) items.push(t);
    if (items.length === 8) break;
  }
  return { body, items };
}

export interface SearchLink {
  site: string;
  url: string;
}

const q = encodeURIComponent;

/** Search pages (no API keys): the agents name courses and jobs, these sites find the real listings. */
export function courseLinks(course: string): SearchLink[] {
  return [
    { site: "Coursera", url: `https://www.coursera.org/search?query=${q(course)}` },
    { site: "edX", url: `https://www.edx.org/search?q=${q(course)}` },
    { site: "YouTube", url: `https://www.youtube.com/results?search_query=${q(course)}` },
  ];
}

export function jobLinks(title: string, location = ""): SearchLink[] {
  const loc = location.trim();
  return [
    { site: "LinkedIn", url: `https://www.linkedin.com/jobs/search/?keywords=${q(title)}${loc ? `&location=${q(loc)}` : ""}` },
    { site: "Indeed", url: `https://www.indeed.com/jobs?q=${q(title)}${loc ? `&l=${q(loc)}` : ""}` },
    { site: "Google", url: `https://www.google.com/search?q=${q(`${title} jobs${loc ? ` ${loc}` : ""}`)}` },
  ];
}

/** Search links for an agent's items, or null for agents without any. */
export function linksFor(agent: AgentId, items: string[], profile: CareerProfile): { label: string; rows: { item: string; links: SearchLink[] }[] } | null {
  if (!items.length) return null;
  if (agent === "learning") return { label: "Find these courses", rows: items.map((item) => ({ item, links: courseLinks(item) })) };
  // A location like "Manila, Philippines (open to remote)" → "Manila, Philippines" for job sites.
  const place = profile.location.replace(/\(.*?\)/g, "").trim();
  if (agent === "jobs") return { label: "Search for these jobs", rows: items.map((item) => ({ item, links: jobLinks(item, place) })) };
  return null;
}

/** Text the sidebar search looks through. */
export function careerSearchText(c: Conversation): string {
  if (!c.career) return "";
  return [...Object.values(c.career.profile), ...AGENTS.map((a) => c.career!.agents[a.id].content)].join("\n").toLowerCase();
}

export function careerToMarkdown(c: Conversation, modelLabel: (id?: string) => string): string {
  const run = c.career!;
  const lines = [`# ${c.title}`, "", `_Career Guidance Factory · Prometheus · ${new Date(c.updatedAt).toLocaleString()}_`, "", "## Your profile", ""];
  for (const f of PROFILE_FIELDS) if (run.profile[f.key]) lines.push(`- **${f.label}:** ${run.profile[f.key]}`);
  lines.push("");
  AGENTS.forEach((a, i) => {
    const r = run.agents[a.id];
    lines.push(`## ${i + 1}. ${a.title}`, "", `_${a.name}${r.model ? ` · ${modelLabel(r.model)}` : ""}_`, "");
    const { body, items } = splitAgentOutput(r.content);
    lines.push(body || (r.error ? `_Error: ${r.error}_` : "_Not generated_"), "");
    const links = linksFor(a.id, items, run.profile);
    if (links) {
      lines.push(`### ${links.label}`, "");
      for (const row of links.rows) lines.push(`- ${row.item}: ${row.links.map((l) => `[${l.site}](${l.url})`).join(" · ")}`);
      lines.push("");
    }
  });
  return lines.join("\n");
}
