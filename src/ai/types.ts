// Provider-neutral AI wire types — mirror src-tauri/src/ai.rs (serde camelCase).
// The backend is a stateless streaming proxy; the agentic loop lives in the
// frontend (agentLoop.ts) and drives tools via the existing `api` wrappers.

export type AiRole = "user" | "assistant";

export type AiBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface AiMessage {
  role: AiRole;
  content: AiBlock[];
}

export interface AiTool {
  name: string;
  description: string;
  /** A JSON Schema object describing the tool input. */
  inputSchema: Record<string, unknown>;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

/** The finished assistant turn returned by `ai_complete` — the source of truth
 *  the loop appends to history and reads tool calls from. */
export interface AiTurn {
  content: AiBlock[];
  stopReason: string;
  usage: AiUsage;
}

/** Streamed during a turn for live display (typing + a "calling tool" hint). */
export type AiEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_use_start"; id: string; name: string };

export type AiProvider = "anthropic" | "openai";

export interface AiCompleteReq {
  provider: AiProvider;
  model: string;
  /** OpenAI-compatible base URL (ignored by the Anthropic provider). */
  baseUrl?: string | null;
  system?: string | null;
  messages: AiMessage[];
  tools: AiTool[];
  maxTokens?: number | null;
}
