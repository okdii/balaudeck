// Local toolset: the agent runs shell commands on the user's OWN machine via a
// one-shot `local_exec` (a fresh non-interactive login shell — it does NOT touch
// the interactive terminal, mirroring how the SSH toolset uses `ssh_exec`).
// Read-only commands may auto-run; everything else is approval-gated (see
// classify.ts + agentLoop.ts). This runs on the user's own computer, which is
// higher-stakes than a remote box, so the write-approval gate matters even more.

import { invoke } from "@tauri-apps/api/core";
import type { AiTool } from "../types";
import type { Toolset, ToolCall, ToolRisk, ToolRunResult } from "../tool";
import { classifyCommand } from "../classify";

const RUN_COMMAND: AiTool = {
  name: "run_command",
  description:
    "Run a shell command on the user's LOCAL machine (this computer) and return its combined output. " +
    "Use it to inspect the system — e.g. `df -h`, `ls -la ~`, `ps aux | grep node`, `uname -a`, `brew list`, `git -C /path status`. " +
    "Each command runs in a fresh non-interactive login shell starting in the home directory — it does NOT share the interactive terminal's current directory, so use absolute paths or `cd <dir> && …` within the one command. " +
    "Prefer read-only commands. Commands that change the machine (installs, deleting/moving/editing files, killing processes, config changes) require the user's approval before they run, so explain what you intend before proposing them. " +
    "Each command runs with a ~15 second timeout and no interactive input — don't launch interactive editors, pagers, or long-running foreground processes.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The exact shell command to run." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

/** The local assistant's system prompt. */
export function localSystemPrompt(): string {
  return [
    "You are BalauDeck's built-in assistant, embedded inside a LOCAL terminal on the user's own computer.",
    "Help them operate and inspect THIS machine.",
    "",
    "You have one tool, run_command, which runs a shell command on the user's local machine and returns its combined output. Guidance:",
    "- This is the user's own computer, not a throwaway remote server — be careful. Prefer read-only, non-interactive commands; gather facts before acting.",
    "- Commands run in a fresh non-interactive login shell starting in the home directory; they don't inherit the interactive terminal's working directory, so use absolute paths or `cd <dir> && …` within a single command.",
    "- Commands that change the machine (installs, file edits/deletes/moves, killing processes, config changes) require the user's approval, so explain what you intend and why before proposing them, and propose the smallest safe command.",
    "- Each command has a ~15 second timeout and no stdin — don't run interactive editors, pagers, or long-running foreground processes.",
    "- Be concise. Summarise findings; show output only when it helps. End with a short, direct answer.",
  ].join("\n");
}

/** Build the local toolset, bound to a getter for the user's chosen shell. */
export function makeLocalToolset(getShell: () => string | null): Toolset {
  return {
    tools: [RUN_COMMAND],
    classify(call: ToolCall): ToolRisk {
      if (call.name !== "run_command") return { level: "write", reason: "unknown tool" };
      const command = typeof call.input.command === "string" ? call.input.command : "";
      return classifyCommand(command);
    },
    async execute(call: ToolCall): Promise<ToolRunResult> {
      if (call.name !== "run_command") {
        return { output: `Unknown tool: ${call.name}`, isError: true };
      }
      const command = typeof call.input.command === "string" ? call.input.command.trim() : "";
      if (!command) return { output: "Empty command.", isError: true };
      try {
        const out = await invoke<string>("local_exec", { command, shell: getShell() });
        // Cap pathological output (e.g. `cat` of a huge file) so it can't blow up
        // the model context / cost. The model can narrow the command if it needs more.
        const CAP = 16000;
        const capped =
          out.length > CAP
            ? out.slice(0, CAP) + `\n… (truncated ${out.length - CAP} more characters)`
            : out;
        return { output: capped.length ? capped : "(command produced no output)", isError: false };
      } catch (e) {
        return { output: String(e), isError: true };
      }
    },
  };
}
