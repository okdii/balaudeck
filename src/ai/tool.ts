// Shared shapes for the agent's tool surface. A `Toolset` bundles the tool
// definitions the model sees, a risk classifier (read-only vs write), and an
// executor. v1 ships one toolset (SSH); DB/others plug in the same way later.

import type { AiTool } from "./types";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type RiskLevel = "read" | "write";

/** A tool call's safety classification. "read" may auto-run (when the user has
 *  auto-run enabled); "write" always requires explicit approval. */
export interface ToolRisk {
  level: RiskLevel;
  /** Short human reason shown on the approval chip for a "write". */
  reason?: string;
}

export interface ToolRunResult {
  output: string;
  isError: boolean;
}

export interface Toolset {
  tools: AiTool[];
  classify: (call: ToolCall) => ToolRisk;
  execute: (call: ToolCall) => Promise<ToolRunResult>;
}
