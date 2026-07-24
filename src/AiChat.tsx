// The AI assistant chat column embedded in the SSH pane. Drives the frontend
// agentic loop (ai/agentLoop.ts) against the pane's live SSH session: streams
// the model's reply, auto-runs read-only commands, and gates writes behind a
// one-click Approve/Deny chip. Provider/model/key come from Settings → AI.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, Spinner } from "./Icon";
import { api } from "./api";
import { getSettings, subscribeSettings, type AiSettings } from "./settings";
import { runAgent, type ApprovalDecision } from "./ai/agentLoop";
import { makeSshToolset } from "./ai/tools/ssh";
import type { AiBlock, AiMessage } from "./ai/types";
import type { ToolCall, ToolRisk, ToolRunResult } from "./ai/tool";

type ToolUseBlock = Extract<AiBlock, { type: "tool_use" }>;

function buildSystemPrompt(label: string, connected: boolean): string {
  const where = connected ? `connected to the server \`${label}\`` : "not connected to any server yet";
  return [
    "You are BalauDeck's built-in assistant, embedded inside an SSH terminal session.",
    `The user is ${where}. Help them operate and inspect the server.`,
    "",
    "You have one tool, run_command, which runs a shell command on the user's live SSH session and returns its combined output. Guidance:",
    "- Prefer read-only, non-interactive commands; gather facts before acting.",
    "- Commands that change the server (installs, service restarts, file edits/deletes, config changes) require the user's approval, so explain what you intend and why before proposing them, and propose the smallest safe command.",
    "- Each command has a ~5 second timeout and no stdin — don't run interactive editors, pagers, or long-running foreground processes.",
    "- Be concise. Summarise findings; show output only when it helps. End with a short, direct answer.",
  ].join("\n");
}

export function AiChat({
  getSessionId,
  sessionLabel,
  connected,
  onClose,
}: {
  getSessionId: () => string | null;
  sessionLabel: string;
  connected: boolean;
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

  const modelLabel = useMemo(
    () => (ai.provider === "anthropic" ? ai.model.replace(/^claude-/, "") : ai.model),
    [ai.provider, ai.model],
  );

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

    const toolset = makeSshToolset(getSessionId);
    try {
      await runAgent({
        req: {
          provider: ai.provider,
          model: ai.model,
          baseUrl: ai.provider === "openai" ? ai.openaiBaseUrl : null,
          system: buildSystemPrompt(sessionLabel, connected),
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
            <p>Ask about this server — "what's using disk?", "is nginx running?", "tail the auth log".</p>
            <p className="ai-empty-sub">
              Read-only commands run automatically; changes ask first.
            </p>
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
                  onDeny={() => resolveApproval(false, "The user declined to run this command.")}
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
  const command =
    typeof block.input.command === "string" ? block.input.command : JSON.stringify(block.input);
  return (
    <div className={"ai-tool" + (pending ? " pending" : "")}>
      <div className="ai-tool-cmd">
        <span className="ai-tool-prompt">$</span>
        <code>{command}</code>
      </div>
      {pending && (
        <div className="ai-approve">
          <span className="ai-approve-why">
            {pending.reason ? `Needs approval — ${pending.reason}` : "Approve to run this command"}
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
