// A chat as a Markdown document — for keeping a troubleshooting session,
// pasting it into a ticket, or sharing what the assistant ran and saw.

import type { AiMessage } from "./types";
import type { ToolRunResult } from "./tool";
import type { RunStats } from "./usage";

/** Fence longer than any backtick run inside `s`, so it never closes early. */
function fence(s: string, lang = ""): string {
  const runs = s.match(/`+/g) ?? [];
  const longest = Math.max(2, ...runs.map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${s.replace(/\n+$/, "")}\n${f}`;
}

/** Fence language for a tool's main argument. */
function langOf(input: Record<string, unknown>): string {
  if (typeof input.sql === "string") return "sql";
  if (typeof input.command === "string") return "sh";
  return "json";
}

export function chatToMarkdown(c: {
  title: string;
  /** e.g. "ssh: deploy@web-01" */
  where?: string;
  updated?: number;
  messages: AiMessage[];
  results?: Record<string, ToolRunResult>;
  runMeta?: Record<number, RunStats>;
}): string {
  const out: string[] = [`# ${c.title}`, ""];
  const meta = [
    c.where ? `**Connection:** ${c.where}` : "",
    `**Exported:** ${new Date().toLocaleString()}`,
    c.updated ? `**Last message:** ${new Date(c.updated).toLocaleString()}` : "",
  ].filter(Boolean);
  out.push(meta.join("  \n"), "");

  // tool_result blocks arrive in the next user message; index them by call id.
  const toolOut = new Map<string, { content: string; isError: boolean }>();
  for (const m of c.messages)
    for (const b of m.content)
      if (b.type === "tool_result") toolOut.set(b.toolUseId, { content: b.content, isError: !!b.isError });

  // One "Assistant" heading per answer, even when it spans several tool turns.
  let lastHeading: "you" | "assistant" | "" = "";
  c.messages.forEach((m, i) => {
    if (m.role === "user") {
      const text = m.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim();
      if (!text) return; // a tool-results-only turn
      out.push("---", "", "### 🧑 You", "", text, "");
      lastHeading = "you";
      return;
    }
    if (lastHeading !== "assistant") out.push("### ✦ Assistant", "");
    lastHeading = "assistant";
    for (const b of m.content) {
      if (b.type === "text" && b.text.trim()) out.push(b.text.trim(), "");
      if (b.type === "tool_use") {
        const main = b.input.sql ?? b.input.command;
        const body = typeof main === "string" ? main : JSON.stringify(b.input, null, 2);
        out.push(`**Ran \`${b.name}\`:**`, "", fence(body, langOf(b.input)), "");
        const r = c.results?.[b.id];
        const res = r ? { content: r.output, isError: r.isError } : toolOut.get(b.id);
        if (res) out.push(res.isError ? "_Error:_" : "_Output:_", "", fence(res.content || "(no output)"), "");
        else out.push("_No output recorded._", "");
      }
    }
    const st = c.runMeta?.[i];
    if (st) {
      const cost = st.cost === null ? "" : st.cost === 0 ? " · free" : ` · ≈$${st.cost.toFixed(4)}`;
      const steps = `${st.steps} step${st.steps === 1 ? "" : "s"}`;
      const tools = `${st.tools} tool call${st.tools === 1 ? "" : "s"}`;
      out.push(`<sub>${st.model} · ${steps} · ${tools} · ${st.inputTokens + st.outputTokens} tokens${cost}</sub>`, "");
    }
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** A safe file name from the chat title: "check disk usage" → "ai-chat-check-disk-usage.md". */
export function chatFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return `ai-chat-${slug || "export"}.md`;
}
