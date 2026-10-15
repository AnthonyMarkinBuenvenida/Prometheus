import type { Conversation } from "../types";
import { careerToMarkdown } from "./career";

export function conversationToMarkdown(c: Conversation, modelLabel: (id?: string) => string): string {
  if (c.career) return careerToMarkdown(c, modelLabel);
  const lines = [`# ${c.title}`, "", `_Exported from Prometheus · ${new Date(c.updatedAt).toLocaleString()}_`, ""];
  for (const m of c.messages) {
    if (m.role === "user") {
      lines.push("## You", "");
      for (const f of m.files ?? []) lines.push(`> Attached: ${f.name}`, "");
      lines.push(m.content, "");
    } else {
      lines.push(`## ${modelLabel(m.model)}`, "");
      lines.push(m.content || (m.error ? `_Error: ${m.error}_` : "_No response_"), "");
    }
  }
  return lines.join("\n");
}
