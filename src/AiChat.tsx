// The AI assistant chat column, embedded in a panel (SSH terminal, SQL DB, …).
// Engine-neutral: the parent supplies a `makeToolset` (bound to its live
// session/connection) and a `buildSystem` prompt; this component drives the
// frontend agentic loop (ai/agentLoop.ts) — streaming the reply, auto-running
// read-only tool calls, and gating writes behind a one-click Approve/Deny chip.
//
// The provider HTTP + API key stay in Rust; this file never sees the key.

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Icon, Spinner } from "./Icon";
import {
  AI_ANTHROPIC_AUTO,
  AI_ANTHROPIC_MODELS,
  getSettings,
  setSettings,
  subscribeSettings,
  type AiSettings,
} from "./settings";
import { api } from "./api";
import { runAgent, type ApprovalDecision } from "./ai/agentLoop";
import { renderMarkdown } from "./ai/markdown";
import {
  emptyRun,
  estimateCost,
  fmtCost,
  fmtDuration,
  fmtTokens,
  fmtCached,
  totalInput,
  type RunStats,
} from "./ai/usage";
import type { AiBlock, AiMessage } from "./ai/types";
import {
  archiveCurrent,
  chatTitle,
  deletePast,
  listPast,
  loadCurrent,
  newChatId,
  reopen,
  saveCurrent,
  type SavedChat,
} from "./ai/chatHistory";
import type { ToolCall, ToolRisk, ToolRunResult, Toolset } from "./ai/tool";
import { chatFileName, chatToMarkdown } from "./ai/chatExport";
import { copyToClipboard } from "./clipboard";
import { saveText } from "./saveFile";

type ToolUseBlock = Extract<AiBlock, { type: "tool_use" }>;

export function AiChat({
  makeToolset,
  buildSystem,
  placeholder,
  onClose,
  headerExtra,
  inject,
  onInjected,
  historyScope,
}: {
  /** Build the toolset bound to the parent's live session/connection. */
  makeToolset: () => Toolset;
  /** Build the system prompt (with the parent's context) for each turn. */
  buildSystem: () => string;
  /** Empty-state hint (what to ask this assistant). */
  placeholder?: string;
  onClose: () => void;
  /** Extra controls in the header (e.g. the SSH "run in terminal" toggle). */
  headerExtra?: ReactNode;
  /** A message to send as if typed (e.g. "Explain error"); cleared via onInjected. */
  inject?: { id: number; text: string } | null;
  onInjected?: () => void;
  /** Where the chat is saved (e.g. `ssh:user@host`); null/undefined = not saved
   *  (yet). Each scope keeps its open chat plus a list of earlier ones. */
  historyScope?: string | null;
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
  // Usage: live stats for the running answer, per-answer stats (keyed by the
  // index of the answer's last message) and the whole chat's totals.
  const [live, setLive] = useState<RunStats | null>(null);
  const [runMeta, setRunMeta] = useState<Record<number, RunStats>>({});
  const emptySession = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, costKnown: true, context: 0 };
  const [session, setSession] = useState(emptySession);
  // Saved chats: the open chat's id, and the history list (when shown).
  const chatIdRef = useRef(newChatId());
  const hydratingRef = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [past, setPast] = useState<SavedChat[]>([]);
  const [now, setNow] = useState(Date.now());
  const [liveStart, setLiveStart] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const stopRef = useRef(false);
  const approveRef = useRef<((d: ApprovalDecision) => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Resizable width (persisted). The handle sits on the pane's left edge —
  // dragging it left widens the chat.
  const [width, setWidth] = useState(() => {
    const w = Number(localStorage.getItem("balaudeck.aiWidth"));
    return w >= 300 && w <= 1200 ? w : 380;
  });
  const resizingRef = useRef(false);
  function startResize(e: ReactPointerEvent) {
    e.preventDefault();
    if (resizingRef.current) return;
    const startX = e.clientX;
    const startW = width;
    const handle = e.currentTarget as HTMLElement;
    resizingRef.current = true;
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    const max = Math.min(1000, Math.round(window.innerWidth * 0.7));
    const onMove = (ev: PointerEvent) =>
      setWidth(Math.min(max, Math.max(300, startW - (ev.clientX - startX))));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.style.cursor = "";
      resizingRef.current = false;
      setWidth((w) => {
        localStorage.setItem("balaudeck.aiWidth", String(w));
        return w;
      });
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  // Whether a key is stored for the active provider (drives the setup banner).
  // Local Ollama needs no key, so never nag for one.
  useEffect(() => {
    if (ai.provider === "ollama") {
      setKeyReady(true);
      return;
    }
    api.aiKeyExists(ai.provider).then(setKeyReady).catch(() => setKeyReady(false));
  }, [ai.provider]);

  // Keep the transcript pinned to the newest message / streamed token.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming, pending]);

  // Model switcher in the header. Claude: the key's model list (+ "auto", shown
  // with what it resolves to); Ollama: installed models; OpenAI-compatible has
  // no list, so it stays a plain label (set it in Settings).
  const [autoModel, setAutoModel] = useState("");
  const [modelList, setModelList] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    setModelList([]);
    if (ai.provider === "anthropic") {
      if (!keyReady) return;
      api
        .aiAnthropicModels()
        .then((r) => {
          setAutoModel(r.latest);
          setModelList(r.models.map((m) => ({ id: m.id, label: m.display_name })));
        })
        .catch(() => {
          setAutoModel("");
          setModelList(AI_ANTHROPIC_MODELS.map((m) => ({ id: m.id, label: m.label.split(" — ")[0] })));
        });
    } else if (ai.provider === "ollama") {
      api
        .aiOllamaModels(ai.ollamaBaseUrl)
        .then((l) => setModelList(l.map((m) => ({ id: m, label: m }))))
        .catch(() => {});
    }
  }, [ai.provider, ai.ollamaBaseUrl, keyReady]);
  const short = (id: string) => id.replace(/^claude-/, "");
  const modelLabel =
    ai.provider === "anthropic"
      ? ai.model === AI_ANTHROPIC_AUTO
        ? autoModel
          ? `${short(autoModel)} (auto)`
          : "latest (auto)"
        : short(ai.model)
      : ai.model;
  const switchable = ai.provider === "anthropic" || modelList.length > 0;
  const pickModel = (model: string) => setSettings({ ai: { ...getSettings().ai, model } });

  function resolveApproval(approved: boolean, reason?: string) {
    approveRef.current?.({ approved, reason });
  }

  function stop() {
    stopRef.current = true;
    resolveApproval(false, "The user stopped the assistant.");
  }

  function applyChat(c: SavedChat | null) {
    hydratingRef.current = true;
    chatIdRef.current = c?.id ?? newChatId();
    setMessages(c?.messages ?? []);
    setResults(c?.results ?? {});
    setRunMeta(c?.runMeta ?? {});
    setSession(c?.session ?? emptySession);
    setStreaming("");
    setError("");
    setLive(null);
  }

  // Open the saved chat when the scope (connection) becomes known or changes.
  // A chat started before the scope was known (e.g. typed while connecting)
  // is kept when the scope has nothing saved.
  useEffect(() => {
    if (!historyScope) return;
    const saved = loadCurrent(historyScope);
    if (saved || messages.length === 0) applyChat(saved);
    setHistoryOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyScope]);

  // Save after every finished answer (never mid-run: a half-done tool turn
  // isn't a valid conversation to resume).
  useEffect(() => {
    if (hydratingRef.current) {
      hydratingRef.current = false;
      return;
    }
    if (!historyScope || running) return;
    saveCurrent(
      historyScope,
      messages.length
        ? {
            id: chatIdRef.current,
            title: chatTitle(messages),
            updated: Date.now(),
            messages,
            results,
            runMeta,
            session,
          }
        : null,
    );
  }, [historyScope, running, messages, results, runMeta, session]);

  // Export (current chat, or one from the history list) as Markdown.
  const [exportOpen, setExportOpen] = useState(false);
  const [exportNote, setExportNote] = useState("");
  function chatMarkdown(c?: SavedChat): { md: string; title: string } {
    const title = c ? c.title : chatTitle(messages);
    const where = historyScope ? historyScope.replace(/^(\w+):/, "$1: ") : undefined;
    const md = c
      ? chatToMarkdown({ title, where, updated: c.updated, messages: c.messages, results: c.results, runMeta: c.runMeta })
      : chatToMarkdown({ title, where, updated: Date.now(), messages, results, runMeta });
    return { md, title };
  }
  function flash(t: string) {
    setExportNote(t);
    setTimeout(() => setExportNote(""), 2500);
  }
  async function exportChat(how: "save" | "copy", c?: SavedChat) {
    setExportOpen(false);
    const { md, title } = chatMarkdown(c);
    try {
      if (how === "copy") {
        await copyToClipboard(md);
        flash("Chat copied as Markdown.");
      } else {
        const path = await saveText(
          { defaultPath: chatFileName(title), filters: [{ name: "Markdown", extensions: ["md"] }] },
          md,
        );
        if (!path) return;
        flash("Chat saved.");
      }
    } catch (e) {
      flash(`Export failed: ${e}`);
    }
  }

  function newChat() {
    if (running) return;
    if (historyScope) archiveCurrent(historyScope);
    applyChat(null);
    setHistoryOpen(false);
  }

  function toggleHistory() {
    if (!historyScope) return;
    if (!historyOpen) setPast(listPast(historyScope));
    setHistoryOpen(!historyOpen);
  }

  function openPast(id: string) {
    if (!historyScope || running) return;
    const c = reopen(historyScope, id);
    if (c) applyChat(c);
    setHistoryOpen(false);
  }

  function removePast(id: string) {
    if (!historyScope) return;
    deletePast(historyScope, id);
    setPast(listPast(historyScope));
  }

  async function send(override?: string) {
    const text = (override ?? input).trim();
    if (!text || running) return;
    setError("");
    if (override === undefined) setInput("");
    const userMsg: AiMessage = { role: "user", content: [{ type: "text", text }] };
    const history = [...messages, userMsg];
    setMessages(history);
    setRunning(true);
    stopRef.current = false;
    const started = Date.now();
    let msgCount = history.length;
    const fallbackModel = ai.model === AI_ANTHROPIC_AUTO ? autoModel || ai.model : ai.model;
    let stats = emptyRun(fallbackModel);
    setNow(started);
    setLiveStart(started);
    setLive(stats);

    const toolset = makeToolset();
    try {
      await runAgent({
        req: {
          provider: ai.provider,
          model: ai.model,
          baseUrl:
            ai.provider === "openai"
              ? ai.openaiBaseUrl
              : ai.provider === "ollama"
                ? ai.ollamaBaseUrl
                : null,
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
          onMessage: (m) => {
            msgCount += 1;
            setMessages((prev) => [...prev, m]);
          },
          onToolResult: (id, res) => {
            setResults((prev) => ({ ...prev, [id]: res }));
            stats = { ...stats, tools: stats.tools + 1 };
            setLive(stats);
          },
          onTurn: (turn) => {
            const model = turn.model || stats.model;
            if (turn.model && ai.provider === "anthropic" && ai.model === AI_ANTHROPIC_AUTO) {
              setAutoModel(turn.model);
            }
            const u = turn.usage;
            const inTok = totalInput(u);
            const cached = u.cacheReadTokens ?? 0;
            const c = estimateCost(ai.provider, model, u);
            stats = {
              ...stats,
              model,
              steps: stats.steps + 1,
              inputTokens: stats.inputTokens + inTok,
              outputTokens: stats.outputTokens + u.outputTokens,
              cachedTokens: stats.cachedTokens + cached,
              cost: stats.cost === null || c === null ? null : stats.cost + c,
              context: inTok + u.outputTokens,
            };
            setLive(stats);
            setSession((s) => ({
              inputTokens: s.inputTokens + inTok,
              outputTokens: s.outputTokens + u.outputTokens,
              cachedTokens: s.cachedTokens + cached,
              cost: s.cost + (c ?? 0),
              costKnown: s.costKnown && c !== null,
              context: inTok + u.outputTokens,
            }));
          },
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
      const done = { ...stats, ms: Date.now() - started };
      if (done.steps > 0) setRunMeta((m) => ({ ...m, [msgCount - 1]: done }));
      setLive(null);
    }
  }

  // Send an injected message once (the parent clears it so a re-mount won't resend).
  const sentInject = useRef(0);
  useEffect(() => {
    if (!inject || inject.id === sentInject.current || running) return;
    sentInject.current = inject.id;
    onInjected?.();
    send(inject.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inject, running]);

  const disabled = running || !ai.enabled;
  const providerFree = ai.provider === "ollama";

  return (
    <div className="ai-chat" style={{ width }}>
      <div className="ai-resize" onPointerDown={startResize} title="Drag to resize" />
      <div className="ai-head">
        <span className="ai-title">
          <Icon name="sparkles" size={14} /> AI
          {switchable ? (
            <span className="ai-model ai-model-pick" title="Switch model (applies to the next message)">
              {modelLabel}
              <Icon name="chevronDown" size={10} />
              <select
                value={ai.model}
                onChange={(e) => pickModel(e.target.value)}
                disabled={running}
                aria-label="AI model"
              >
                {ai.provider === "anthropic" && (
                  <option value={AI_ANTHROPIC_AUTO}>
                    Latest (auto){autoModel ? ` — ${short(autoModel)}` : ""}
                  </option>
                )}
                {!(ai.provider === "anthropic" && ai.model === AI_ANTHROPIC_AUTO) &&
                  !modelList.some((m) => m.id === ai.model) && (
                    <option value={ai.model}>{ai.model}</option>
                  )}
                {modelList.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </span>
          ) : (
            <span className="ai-model">{modelLabel}</span>
          )}
        </span>
        <div className="ai-head-actions">
          {headerExtra}
          {historyScope && (
            <button
              className={"icon" + (historyOpen ? " active" : "")}
              title="Earlier chats"
              onClick={toggleHistory}
              disabled={running}
            >
              <Icon name="clock" size={14} />
            </button>
          )}
          <span className="ai-export-wrap">
            <button
              className={"icon" + (exportOpen ? " active" : "")}
              title="Export chat as Markdown"
              onClick={() => setExportOpen((o) => !o)}
              disabled={messages.length === 0}
            >
              <Icon name="download" size={14} />
            </button>
            {exportOpen && (
              <>
                <div className="ai-export-backdrop" onClick={() => setExportOpen(false)} />
                <div className="ai-export-menu">
                  <button className="ghost" onClick={() => void exportChat("save")}>
                    <Icon name="save" size={13} /> Save as Markdown…
                  </button>
                  <button className="ghost" onClick={() => void exportChat("copy")}>
                    <Icon name="copy" size={13} /> Copy as Markdown
                  </button>
                </div>
              </>
            )}
          </span>
          <button className="icon" title="New chat (the current one is kept in history)" onClick={newChat} disabled={running}>
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

      {exportNote && <div className="ai-export-note">{exportNote}</div>}

      {historyOpen && (
        <div className="ai-history">
          <div className="ai-history-head">Earlier chats · {historyScope?.replace(/^\w+:/, "")}</div>
          {past.length === 0 ? (
            <div className="ai-history-empty">No earlier chats yet. New chat (+) keeps the current one here.</div>
          ) : (
            past.map((c) => (
              <div key={c.id} className="ai-history-row" onClick={() => openPast(c.id)} title="Reopen this chat">
                <span className="ai-history-title">{c.title}</span>
                <span className="ai-history-when">{fmtWhen(c.updated)}</span>
                <button
                  className="icon"
                  title="Save as Markdown…"
                  onClick={(e) => {
                    e.stopPropagation();
                    void exportChat("save", c);
                  }}
                >
                  <Icon name="download" size={13} />
                </button>
                <button
                  className="icon"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    removePast(c.id);
                  }}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            ))
          )}
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

        {messages.map((m, mi) => [
          ...m.content.map((b, bi) => {
            const key = `${mi}:${bi}`;
            if (b.type === "text") {
              if (!b.text.trim()) return null;
              const isUser = m.role === "user";
              // A user message with code (e.g. "Analyse with AI") reads better formatted.
              const md = !isUser || b.text.includes("```");
              return (
                <div key={key} className={"ai-msg " + (isUser ? "user" : "assistant") + (md ? " md" : "")}>
                  {md ? renderMarkdown(b.text) : b.text}
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
          runMeta[mi] ? <RunMetaLine key={`meta${mi}`} stats={runMeta[mi]} provider={ai.provider} /> : null,
        ])}

        {streaming && <div className="ai-msg assistant streaming">{streaming}</div>}
        {running && !streaming && !pending && (
          <div className="ai-msg assistant thinking">
            <Spinner size={13} /> {live && live.tools > 0 ? "working" : "thinking"}…
            {live && (
              <span className="ai-live">
                {live.steps > 0 && ` · step ${live.steps + 1}`}
                {live.tools > 0 && ` · ${live.tools} ${live.tools === 1 ? "command" : "commands"}`}
                {live.inputTokens > 0 && ` · ${fmtTokens(live.inputTokens + live.outputTokens)} tokens`}
                {` · ${fmtDuration(Math.max(0, now - liveStart))}`}
              </span>
            )}
          </div>
        )}
        {error && <div className="ai-error">{error}</div>}
      </div>

      <div className="ai-foot">
        {session.inputTokens + session.outputTokens > 0 && (
          <div
            className="ai-usage"
            title={
              "Tokens used in this chat (input / output). Every step re-sends the conversation, so input grows " +
              "with each command; with Claude most of it is read from the prompt cache at ~10% of the price. " +
              "Cost is an estimate from list prices — your provider's console has the bill. " +
              "Context = what the next message will carry; start a New chat (+) to reset it."
            }
          >
            <span>
              {fmtTokens(session.inputTokens)} in · {fmtTokens(session.outputTokens)} out
              {session.cachedTokens > 0 && ` · ${fmtCached(session.cachedTokens, session.inputTokens)}`}
            </span>
            {(providerFree || session.costKnown) && (
              <span className="ai-usage-cost">{providerFree ? "free (local)" : fmtCost(session.cost)}</span>
            )}
            <span className="ai-usage-ctx">context {fmtTokens(session.context)}</span>
          </div>
        )}
        <div className={"ai-input" + (running ? " running" : "")}>
          <textarea
            rows={2}
            value={input}
            placeholder={
              !ai.enabled
                ? "AI is disabled in Settings"
                : running
                  ? "Working… you can type your next message"
                  : "Message the assistant…  (Enter to send, Shift+Enter for a new line)"
            }
            disabled={!ai.enabled}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!running) send();
              }
            }}
          />
          {running ? (
            <button className="ai-send stop" onClick={stop} title="Stop the assistant">
              <span className="ai-stop-square" /> Stop
            </button>
          ) : (
            <button
              className="ai-send"
              onClick={() => send()}
              disabled={disabled || !input.trim()}
              title="Send (Enter)"
            >
              <Icon name="arrow-up" size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** One line under an answer: model · steps · commands · tokens · cost · time. */
function RunMetaLine({ stats, provider }: { stats: RunStats; provider: AiSettings["provider"] }) {
  const parts = [
    stats.model.replace(/^claude-/, ""),
    stats.tools > 0 ? `${stats.tools} ${stats.tools === 1 ? "command" : "commands"}` : "",
    `${fmtTokens(stats.inputTokens)} in / ${fmtTokens(stats.outputTokens)} out`,
    fmtCached(stats.cachedTokens, stats.inputTokens),
    provider === "ollama" ? "" : fmtCost(stats.cost),
    fmtDuration(stats.ms),
  ].filter(Boolean);
  return (
    <div
      className="ai-run-meta"
      title={`${stats.steps} model ${stats.steps === 1 ? "call" : "calls"}; context now ${fmtTokens(stats.context)} tokens`}
    >
      {parts.join(" · ")}
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
  // Finished calls collapse to one line (first line of the command/SQL + a
  // status mark) so a long run of queries doesn't bury the answer; click to
  // see the full command and its output. Approvals always show in full.
  const [open, setOpen] = useState(false);
  const expanded = open || !!pending;
  const summary = label.replace(/\s+/g, " ").trim();
  const status = pending ? "wait" : !result ? "run" : result.isError ? "err" : "ok";
  return (
    <div className={"ai-tool" + (pending ? " pending" : "") + (expanded ? " open" : "")}>
      <button
        type="button"
        className="ai-tool-head"
        onClick={() => setOpen((o) => !o)}
        disabled={!!pending}
        title={expanded ? "Hide details" : "Show the full command and its output"}
      >
        <span className={"ai-tool-status " + status}>
          {status === "run" ? (
            <Spinner size={11} />
          ) : status === "ok" ? (
            <Icon name="check" size={11} />
          ) : status === "err" ? (
            <Icon name="x" size={11} />
          ) : (
            "!"
          )}
        </span>
        <span className="ai-tool-name">{block.name.replace(/_/g, " ")}</span>
        {!expanded && <code className="ai-tool-sum">{summary}</code>}
        <Icon name={expanded ? "chevronDown" : "chevronRight"} size={12} className="ai-tool-chev" />
      </button>
      {expanded && (
        <div className="ai-tool-cmd">
          <span className="ai-tool-prompt">›</span>
          <code>{label}</code>
        </div>
      )}
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
      {result && expanded && (
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

/** "14:05" today, "3 Nov" this year, else "3 Nov 2025". */
function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const n = new Date();
  if (d.toDateString() === n.toDateString())
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() === n.getFullYear() ? {} : { year: "numeric" }),
  });
}
