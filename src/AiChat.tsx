// The AI assistant chat column, embedded in a panel (SSH terminal, SQL DB, …).
// Engine-neutral: the parent supplies a `makeToolset` (bound to its live
// session/connection) and a `buildSystem` prompt; this component drives the
// frontend agentic loop (ai/agentLoop.ts) — streaming the reply, auto-running
// read-only tool calls, and gating writes behind a one-click Approve/Deny chip.
//
// The provider HTTP + API key stay in Rust; this file never sees the key.

import { useEffect, useRef, useState } from "react";
import { Icon, Spinner } from "./Icon";
import { getSettings, subscribeSettings, type AiSettings } from "./settings";
import { api } from "./api";
import { runAgent, type ApprovalDecision } from "./ai/agentLoop";
import type { AiBlock, AiMessage } from "./ai/types";
import type { ToolCall, ToolRisk, ToolRunResult, Toolset } from "./ai/tool";

type ToolUseBlock = Extract<AiBlock, { type: "tool_use" }>;

export function AiChat({
  makeToolset,
  buildSystem,
  placeholder,
  onClose,
}: {
  /** Build the toolset bound to the parent's live session/connection. */
  makeToolset: () => Toolset;
  /** Build the system prompt (with the parent's context) for each turn. */
  buildSystem: () => string;
  /** Empty-state hint (what to ask this assistant). */
  placeholder?: string;
  onClose: () => void;
}) {
  const [ai, setAi] = useState<AiSettings>(getSettings().ai);
  useEffect(() => subscribeSettings(() => setAi(getSettings().ai)), []);

  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ call: ToolCall; risk: ToolRisk } | null>(null);
  const [results, setResults] = useState<Record<string, ToolRunResult>>({});
  const [keyReady, setKeyReady] = useState(true);

  const stopRef = useRef(false);
  const approveRef = useRef<((d: ApprovalDecision) => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Whether a key is stored for the active provider (drives the setup banner).
  useEffect(() => {
    api.aiKeyExists(ai.provider).then(setKeyReady).catch(() => setKeyReady(false));
  }, [ai.provider]);

  // Keep the transcript pinned to the newest message / streamed token.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming, pending]);

  const modelLabel = ai.provider === "anthropic" ? ai.model.replace(/^claude-/, "") : ai.model;

  function resolveApproval(approved: boolean, reason?: string) {
    approveRef.current?.({ approved, reason });
  }

  function stop() {
    stopRef.current = true;
    resolveApproval(false, "The user stopped the assistant.");
  }

  function newChat() {
    if (running) return;
    setMessages([]);
    setResults({});
    setStreaming("");
    setError("");
  }

  async function send() {
    const text = input.trim();
    if (!text || running) return;
    setError("");
    setInput("");
    const userMsg: AiMessage = { role: "user", content: [{ type: "text", text }] };
    const history = [...messages, userMsg];
    setMessages(history);
    setRunning(true);
    stopRef.current = false;

    const toolset = makeToolset();
    try {
      await runAgent({
        req: {
          provider: ai.provider,
          model: ai.model,
          baseUrl: ai.provider === "openai" ? ai.openaiBaseUrl : null,
          system: buildSystem(),
          tools: toolset.tools,
          maxTokens: 4096,
        },
        history,
        toolset,
        autoRunReadOnly: ai.autoRunReadOnly,
        stop: () => stopRef.current,
        hooks: {
          onStreaming: setStreaming,
          onMessage: (m) => setMessages((prev) => [...prev, m]),
          onToolResult: (id, res) => setResults((prev) => ({ ...prev, [id]: res })),
          onApproval: (call, risk) =>
            new Promise<ApprovalDecision>((resolve) => {
              setPending({ call, risk });
              approveRef.current = (d) => {
                setPending(null);
                approveRef.current = null;
                resolve(d);
              };
            }),
          onError: setError,
        },
      });
    } finally {
      setRunning(false);
      setStreaming("");
    }
  }

  const disabled = running || !ai.enabled;

  return (
    <div className="ai-chat">
      <div className="ai-head">
        <span className="ai-title">
          <Icon name="sparkles" size={14} /> AI
          <span className="ai-model">{modelLabel}</span>
        </span>
        <div className="ai-head-actions">
          <button className="icon" title="New chat" onClick={newChat} disabled={running}>
            <Icon name="plus" size={14} />
          </button>
          <button className="icon" title="Hide assistant" onClick={onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>
      </div>

      {!keyReady && (
        <div className="ai-banner">
          No API key for {ai.provider === "anthropic" ? "Claude" : "this provider"} yet. Add it in
          Settings → AI Assistant.
        </div>
      )}

      <div className="ai-scroll" ref={scrollRef}>
        {messages.length === 0 && !streaming && (
          <div className="ai-empty">
            <Icon name="sparkles" size={22} />
            <p>{placeholder || "Ask the assistant anything about this session."}</p>
            <p className="ai-empty-sub">Read-only actions run automatically; changes ask first.</p>
          </div>
        )}

        {messages.map((m, mi) =>
          m.content.map((b, bi) => {
            const key = `${mi}:${bi}`;
            if (b.type === "text") {
              if (!b.text.trim()) return null;
              return (
                <div key={key} className={"ai-msg " + (m.role === "user" ? "user" : "assistant")}>
                  {b.text}
                </div>
              );
            }
            if (b.type === "tool_use") {
              return (
                <ToolChip
                  key={key}
                  block={b}
                  result={results[b.id]}
                  pending={pending && pending.call.id === b.id ? pending.risk : null}
                  onApprove={() => resolveApproval(true)}
                  onDeny={() => resolveApproval(false, "The user declined to run this action.")}
                />
              );
            }
            return null; // tool_result blocks render under their tool chip
          }),
        )}

        {streaming && <div className="ai-msg assistant streaming">{streaming}</div>}
        {running && !streaming && !pending && (
          <div className="ai-msg assistant thinking">
            <Spinner size={13} /> thinking…
          </div>
        )}
        {error && <div className="ai-error">{error}</div>}
      </div>

      <div className="ai-input">
        <textarea
          rows={2}
          value={input}
          placeholder={ai.enabled ? "Message the assistant…" : "AI is disabled in Settings"}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {running ? (
          <button className="ai-send stop" onClick={stop} title="Stop">
            <Icon name="x" size={15} />
          </button>
        ) : (
          <button
            className="ai-send"
            onClick={send}
            disabled={disabled || !input.trim()}
            title="Send"
          >
            <Icon name="play" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

function ToolChip({
  block,
  result,
  pending,
  onApprove,
  onDeny,
}: {
  block: ToolUseBlock;
  result?: ToolRunResult;
  pending: ToolRisk | null;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const label = toolLabel(block);
  return (
    <div className={"ai-tool" + (pending ? " pending" : "")}>
      <div className="ai-tool-cmd">
        <span className="ai-tool-prompt">›</span>
        <code>{label}</code>
      </div>
      {pending && (
        <div className="ai-approve">
          <span className="ai-approve-why">
            {pending.reason ? `Needs approval — ${pending.reason}` : "Approve to run this action"}
          </span>
          <div className="ai-approve-btns">
            <button className="ok" onClick={onApprove}>
              <Icon name="check" size={13} /> Approve
            </button>
            <button className="ghost" onClick={onDeny}>
              Deny
            </button>
          </div>
        </div>
      )}
      {result && (
        <pre className={"ai-tool-out" + (result.isError ? " err" : "")}>{result.output}</pre>
      )}
    </div>
  );
}

/** A compact, human label for a tool call: the command/SQL when present,
 *  otherwise `name(json)`. */
function toolLabel(block: ToolUseBlock): string {
  const first = block.input.command ?? block.input.sql;
  if (typeof first === "string" && first.trim()) return first;
  const args = Object.entries(block.input)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
  return args ? `${block.name}(${args})` : block.name;
}
