// The manual agentic tool-use loop (runs in the frontend). Each iteration calls
// the provider through `api.aiComplete` (streaming text deltas for live
// display), appends the assistant turn, then for each tool_use block either
// auto-runs it (read-only + auto-run enabled) or awaits the user's approval,
// feeds the results back, and repeats until the model stops calling tools.
//
// The provider HTTP + API key stay in Rust; this file never sees the key.

import { Channel } from "@tauri-apps/api/core";
import { api } from "../api";
import type { AiBlock, AiCompleteReq, AiEvent, AiMessage, AiTurn } from "./types";
import type { ToolCall, ToolRisk, ToolRunResult, Toolset } from "./tool";

export interface ApprovalDecision {
  approved: boolean;
  /** Shown back to the model as the tool result when denied. */
  reason?: string;
}

export interface AgentHooks {
  /** Live text of the current assistant turn; called with the growing string,
   *  and with "" to clear once the turn is finalized. */
  onStreaming: (text: string) => void;
  /** A finished message (assistant, or the user turn carrying tool results)
   *  was appended to the conversation. */
  onMessage: (msg: AiMessage) => void;
  /** Ask the user to approve a write/unknown (or, with auto-run off, any) tool
   *  call. Resolve with the decision. */
  onApproval: (call: ToolCall, risk: ToolRisk) => Promise<ApprovalDecision>;
  /** A tool finished (for progressive display; the result is also part of the
   *  tool-result message delivered via `onMessage`). */
  onToolResult?: (id: string, result: ToolRunResult) => void;
  onError: (message: string) => void;
}

export interface RunAgentConfig {
  req: Omit<AiCompleteReq, "messages">;
  /** Prior turns plus the new user message (last entry). */
  history: AiMessage[];
  toolset: Toolset;
  autoRunReadOnly: boolean;
  hooks: AgentHooks;
  /** Cooperative cancel — checked between and within iterations. */
  stop: () => boolean;
  maxIterations?: number;
}

const isToolUse = (b: AiBlock): b is Extract<AiBlock, { type: "tool_use" }> =>
  b.type === "tool_use";

export async function runAgent(cfg: RunAgentConfig): Promise<void> {
  const messages: AiMessage[] = [...cfg.history];
  const max = cfg.maxIterations ?? 15;

  for (let step = 0; step < max; step++) {
    if (cfg.stop()) return;

    // --- one model turn, streamed for the typing effect --------------------
    let streamed = "";
    const channel = new Channel<AiEvent>();
    channel.onmessage = (ev) => {
      if (ev.kind === "text_delta") {
        streamed += ev.text;
        cfg.hooks.onStreaming(streamed);
      }
    };
    let turn: AiTurn;
    try {
      turn = await api.aiComplete({ ...cfg.req, messages }, channel);
    } catch (e) {
      cfg.hooks.onStreaming("");
      cfg.hooks.onError(String(e));
      return;
    }
    cfg.hooks.onStreaming("");

    const assistant: AiMessage = { role: "assistant", content: turn.content };
    messages.push(assistant);
    cfg.hooks.onMessage(assistant);

    const calls = turn.content.filter(isToolUse);
    if (calls.length === 0) return; // model produced a final answer

    // --- run / approve each tool call --------------------------------------
    const results: AiBlock[] = [];
    for (const c of calls) {
      if (cfg.stop()) return;
      const call: ToolCall = { id: c.id, name: c.name, input: c.input };
      const risk = cfg.toolset.classify(call);

      let result: ToolRunResult;
      if (risk.level === "write" || !cfg.autoRunReadOnly) {
        const decision = await cfg.hooks.onApproval(call, risk);
        if (!decision.approved) {
          result = {
            output: decision.reason || "The user declined to run this command.",
            isError: true,
          };
          cfg.hooks.onToolResult?.(c.id, result);
          results.push({ type: "tool_result", toolUseId: c.id, content: result.output, isError: true });
          continue;
        }
      }

      try {
        result = await cfg.toolset.execute(call);
      } catch (e) {
        result = { output: String(e), isError: true };
      }
      cfg.hooks.onToolResult?.(c.id, result);
      results.push({
        type: "tool_result",
        toolUseId: c.id,
        content: result.output || "(no output)",
        isError: result.isError,
      });
    }

    const toolMsg: AiMessage = { role: "user", content: results };
    messages.push(toolMsg);
    cfg.hooks.onMessage(toolMsg);
  }

  cfg.hooks.onError(`Stopped after ${max} steps (safety cap reached).`);
}
