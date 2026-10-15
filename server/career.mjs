// Career Guidance Factory: four agents that run one after another for POST /api/career.
// Each agent is one model call; it sees the user's profile and every earlier agent's output.
// Pure (no I/O) so prompts, validation and message building can be unit-tested.
//
//   Skills Agent        evaluates the skills the user listed
//   Career Agent        recommends careers that fit those skills and interests
//   Learning Agent      turns the top careers into a phased learning roadmap with courses
//   Job Matching Agent  identifies suitable roles and how to find them
//
// The agents never write URLs: the Learning and Job Matching agents end with a small JSON block of
// course / job names, and the browser turns those into search links (src/lib/career.ts).

/** Profile fields: [key, label, max characters, required]. */
export const PROFILE_FIELDS = [
  ["skills", "Skills", 3000, true],
  ["interests", "Interests", 2000, false],
  ["education", "Education and experience", 1000, false],
  ["goals", "Career goals", 2000, false],
  ["location", "Location", 120, false],
];

/** Longest earlier-agent output accepted when resuming a run (the browser sends them back). */
export const MAX_AGENT_OUTPUT_CHARS = 40_000;

const RULES = [
  "Write in clear, encouraging, practical language, in the same language as the user's profile.",
  "Use Markdown: short sections with headings, bullet lists and tables where they help. No preamble, no sign-off.",
  "Base everything on the profile and the earlier agents' work. Do not invent facts about the user.",
  "Never write URLs or links.",
].join("\n");

export const AGENTS = [
  {
    id: "skills",
    name: "Skills Agent",
    // Router tier for the thinking effort: fast → low, general → medium.
    tier: "fast",
    maxTokens: 6000,
    system: `You are the Skills Agent of a career guidance team. You evaluate the skills a user lists.
${RULES}

Produce:
1. **Summary**: 2–3 sentences on the overall skill profile.
2. A table: | Skill | Level | Notes |. Level is Beginner, Intermediate or Advanced, estimated from what the user wrote (say when it is a guess). Group related skills.
3. **Strengths**: the 3–5 strongest assets for the user's goals.
4. **Gaps**: the most important missing or weak skills for the goals and interests, most important first.
Keep it under 400 words.`,
  },
  {
    id: "career",
    name: "Career Agent",
    tier: "general",
    maxTokens: 8000,
    system: `You are the Career Agent of a career guidance team. Using the user's profile and the Skills Agent's evaluation, you recommend careers.
${RULES}

Recommend 3 to 5 careers, best fit first. For each one write a "### <career title>" heading, then:
- **Fit:** a score out of 100 and one sentence why.
- **What the work involves:** 1–2 sentences.
- **Skills you already have:** from the evaluation.
- **Skills to build:** the main gaps for this career.
- **Typical entry path:** e.g. internship, junior role, certification.
End with a one-paragraph **Recommendation** naming the best starting path.
Keep it under 650 words.`,
  },
  {
    id: "learning",
    name: "Learning Agent",
    tier: "general",
    maxTokens: 10000,
    system: `You are the Learning Agent of a career guidance team. Using the profile, the skills evaluation and the recommended careers, you build a personalized learning roadmap for the top 1–2 careers.
${RULES}

Structure it in phases:
### Phase 1 (0–3 months), ### Phase 2 (3–6 months), ### Phase 3 (6–12 months)
For each phase give: the goal, the skills to learn, 2–4 recommended courses or certifications (real, well-known ones, written as "Course name (Platform)"), and one hands-on portfolio project.
Then a short **Weekly routine** suggestion (hours per week and how to split them).
Keep it under 750 words.

After the roadmap, end your answer with exactly one fenced code block in this form, listing up to 8 of the course or topic names you recommended, without platform names:
\`\`\`json
{"courses": ["Course or topic name", "..."]}
\`\`\``,
  },
  {
    id: "jobs",
    name: "Job Matching Agent",
    tier: "fast",
    maxTokens: 8000,
    system: `You are the Job Matching Agent of a career guidance team. Using the profile and the other agents' work, you identify suitable job opportunities.
${RULES}
Do not invent specific companies' current job openings, salaries you cannot support, or application deadlines.

Produce:
1. A table: | Role | Why it matches | Ready when |. List 4–8 realistic roles (internships, entry-level and next-step roles). "Ready when" is Now, After Phase 1, After Phase 2 or After Phase 3 of the learning roadmap.
2. **Where to look**: kinds of employers and industries that hire for these roles; if the user gave a location, tailor this to it (local job boards, remote options).
3. **Search keywords**: the job titles and keywords to search for.
4. **Application tips**: 3–5 concrete tips (resume, portfolio, interviews) for this profile.
Keep it under 600 words.

After that, end your answer with exactly one fenced code block in this form, listing up to 8 job titles to search for:
\`\`\`json
{"jobs": ["Job title", "..."]}
\`\`\``,
  },
];

export class CareerInputError extends Error {}

/** Validates the profile sent by the browser. Returns trimmed strings for every field. */
export function validateProfile(input) {
  if (!input || typeof input !== "object") throw new CareerInputError("Fill in your profile first.");
  const profile = {};
  for (const [key, label, max, required] of PROFILE_FIELDS) {
    const v = input[key] ?? "";
    if (typeof v !== "string") throw new CareerInputError(`${label} must be text.`);
    const t = v.trim();
    if (required && !t) throw new CareerInputError(`${label} is required.`);
    if (t.length > max) throw new CareerInputError(`${label} is too long (at most ${max.toLocaleString("en-US")} characters).`);
    profile[key] = t;
  }
  return profile;
}

/**
 * Validates where a run starts (0 = from the Skills Agent) and the outputs of the agents before it,
 * which the browser sends back when a run is resumed.
 */
export function validateResume(from, previous) {
  const start = from === undefined ? 0 : from;
  if (!Number.isInteger(start) || start < 0 || start >= AGENTS.length) throw new CareerInputError("Invalid starting agent.");
  const outputs = {};
  for (const agent of AGENTS.slice(0, start)) {
    const text = previous?.[agent.id];
    if (typeof text !== "string" || !text.trim()) throw new CareerInputError(`The ${agent.name}'s earlier result is missing. Start a new roadmap.`);
    if (text.length > MAX_AGENT_OUTPUT_CHARS) throw new CareerInputError(`The ${agent.name}'s earlier result is too long.`);
    outputs[agent.id] = text;
  }
  return { start, outputs };
}

function profileBlock(profile) {
  return PROFILE_FIELDS.map(([key, label]) => `${label}: ${profile[key] || "(not given)"}`).join("\n");
}

/** The single user message an agent receives: the profile plus the earlier agents' outputs. */
export function agentMessages(index, profile, outputs) {
  const parts = [`## User profile\n${profileBlock(profile)}`];
  for (const prev of AGENTS.slice(0, index)) parts.push(`## ${prev.name} output\n${outputs[prev.id]}`);
  parts.push(`## Your task\nDo your part as the ${AGENTS[index].name}, following your instructions.`);
  return [{ role: "user", content: parts.join("\n\n") }];
}
