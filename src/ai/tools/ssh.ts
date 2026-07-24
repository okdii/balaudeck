// SSH toolset: the agent runs shell commands on the pane's live SSH session via
// the existing `ssh_exec` command. Read-only commands may auto-run; everything
// else is approval-gated (see classify.ts + agentLoop.ts).

import { invoke } from "@tauri-apps/api/core";
import type { AiTool } from "../types";
import type { Toolset, ToolCall, ToolRisk, ToolRunResult } from "../tool";
import { classifyCommand } from "../classify";

const RUN_COMMAND: AiTool = {
  name: "run_command",
  description:
    "Run a shell command on the user's connected SSH session and return its combined output. " +
    "Use it to inspect the server — e.g. `df -h`, `ls -la /var/log`, `systemctl status nginx`, `cat /etc/os-release`, `ps aux | grep node`. " +
    "Prefer read-only commands. Commands that change state (installs, service restarts, file edits/deletes, config changes) require the user's approval before they run, so explain what you intend before proposing them. " +
    "Each command runs with a ~5 second timeout and no interactive input — don't launch interactive editors, pagers, or long-running foreground processes.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The exact shell command to run." },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

/** Build the SSH toolset bound to a getter for the pane's live session id. */
export function makeSshToolset(getSessionId: () => string | null): Toolset {
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
      const id = getSessionId();
      if (!id) return { output: "No active SSH session — connect first.", isError: true };
      const command = typeof call.input.command === "string" ? call.input.command.trim() : "";
      if (!command) return { output: "Empty command.", isError: true };
      try {
        const out = await invoke<string>("ssh_exec", { id, cmd: command });
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
