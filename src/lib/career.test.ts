import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENTS, careerTitle, careerToMarkdown, EXAMPLE_PROFILE, jobLinks, linksFor, newRun, resumeIndex, settleRun, splitAgentOutput } from "./career.ts";
import type { Conversation } from "../types";

test("agents match the server's order", () => {
  assert.deepEqual(AGENTS.map((a) => a.id), ["skills", "career", "learning", "jobs"]);
});

test("the JSON block of names is split off and cleaned", () => {
  const text = 'Roadmap text.\n\n```json\n{"courses": ["Machine Learning", " machine learning ", "SQL for Data Science", 7, "' + "x".repeat(81) + '"]}\n```\n';
  assert.deepEqual(splitAgentOutput(text), { body: "Roadmap text.", items: ["Machine Learning", "SQL for Data Science"] });
});

test("while the block streams in, it is hidden and gives no items", () => {
  assert.deepEqual(splitAgentOutput('Jobs.\n\n```json\n{"jobs": ["Data'), { body: "Jobs.", items: [] });
  assert.deepEqual(splitAgentOutput("Jobs.\n\n```js"), { body: "Jobs.\n\n```js", items: [] });
});

test("no block, or an invalid one, leaves the text without items", () => {
  assert.deepEqual(splitAgentOutput("Just text"), { body: "Just text", items: [] });
  assert.deepEqual(splitAgentOutput("A\n```json\nnot json\n```"), { body: "A", items: [] });
});

test("only the last JSON block is treated as the item list; at most 8 items", () => {
  const many = JSON.stringify({ jobs: Array.from({ length: 12 }, (_, i) => `Role ${i}`) });
  const { body, items } = splitAgentOutput('Example:\n```json\n{"a": 1}\n```\nMore.\n```json\n' + many + "\n```");
  assert.match(body, /Example:[\s\S]*More\.$/);
  assert.equal(items.length, 8);
});

test("job links carry the title and location, encoded", () => {
  const [linkedin, indeed, google] = jobLinks("Junior Data Analyst", "Manila, Philippines");
  assert.equal(linkedin.url, "https://www.linkedin.com/jobs/search/?keywords=Junior%20Data%20Analyst&location=Manila%2C%20Philippines");
  assert.equal(indeed.url, "https://www.indeed.com/jobs?q=Junior%20Data%20Analyst&l=Manila%2C%20Philippines");
  assert.equal(google.url, "https://www.google.com/search?q=Junior%20Data%20Analyst%20jobs%20Manila%2C%20Philippines");
  assert.ok(!jobLinks("Intern", "")[0].url.includes("location"));
});

test("links per agent: courses for Learning, jobs (location without notes) for Job Matching, none otherwise", () => {
  assert.equal(linksFor("learning", ["SQL"], EXAMPLE_PROFILE)?.rows[0].links[0].site, "Coursera");
  assert.match(linksFor("jobs", ["Intern"], EXAMPLE_PROFILE)!.rows[0].links[0].url, /location=Manila%2C%20Philippines$/);
  assert.equal(linksFor("skills", ["x"], EXAMPLE_PROFILE), null);
  assert.equal(linksFor("jobs", [], EXAMPLE_PROFILE), null);
});

test("resume point and reload settling", () => {
  const run = newRun(EXAMPLE_PROFILE);
  assert.equal(resumeIndex(run), 0);
  run.agents.skills = { status: "done", content: "s" };
  run.agents.career = { status: "running", content: "partial" };
  assert.equal(resumeIndex(run), 1);
  assert.equal(settleRun(run).agents.career.status, "stopped");
  for (const a of AGENTS) run.agents[a.id] = { status: "done", content: a.id };
  assert.equal(resumeIndex(run), -1);
  assert.equal(settleRun(run), run);
});

test("title and Markdown export", () => {
  assert.equal(careerTitle({ ...EXAMPLE_PROFILE, goals: "Data analyst" }), "Roadmap: Data analyst");
  assert.ok(careerTitle(EXAMPLE_PROFILE).length <= 52);
  const run = newRun(EXAMPLE_PROFILE);
  run.agents.learning = { status: "done", content: 'Plan.\n```json\n{"courses": ["Deep Learning"]}\n```', model: "m1" };
  const c: Conversation = { id: "1", title: "Roadmap", createdAt: 0, updatedAt: 0, messages: [], kind: "career", career: run };
  const md = careerToMarkdown(c, (id) => `Model ${id}`);
  assert.match(md, /## Your profile/);
  assert.match(md, /## 3\. Learning roadmap\n\n_Learning Agent · Model m1_\n\nPlan\.\n/);
  assert.match(md, /- Deep Learning: \[Coursera\]\(https:\/\/www\.coursera\.org\/search\?query=Deep%20Learning\)/);
  assert.doesNotMatch(md, /```json/);
  assert.match(md, /_Not generated_/);
});
