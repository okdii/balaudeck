// Warp-style AI inside the terminal itself (SSH panes):
//  1. askCommand  — natural language → one shell command, typed (not run) at
//                   the prompt for the user to review and press Enter.
//  2. makeTerminalToolset — the chat agent's run_command types into the LIVE
//                   shell (same cwd/env/sudo, visible to the user) and reads the
//                   output back from the stream, instead of a hidden exec channel.
//  3. looksLikeError — heuristics for the "Explain error" chip after a command.

import { Channel } from "@tauri-apps/api/core";
import type { Terminal } from "@xterm/xterm";
import { api } from "../api";
import { getSettings } from "../settings";
import type { AiEvent, AiTool } from "./types";
import type { Toolset, ToolCall, ToolRisk, ToolRunResult } from "./tool";
import { classifyCommand } from "./classify";

// ---- shared ----------------------------------------------------------------

/** Last `n` lines of the terminal up to the cursor (trailing blanks dropped). */
export function screenText(term: Terminal, n = 40, fromRow?: number): string {
  const buf = term.buffer.active;
  const end = buf.baseY + buf.cursorY;
  const start = Math.max(0, fromRow ?? end - n + 1, end - 400);
  const out: string[] = [];
  for (let r = start; r <= end; r++) out.push(buf.getLine(r)?.translateToString(true) ?? "");
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}

/** Strip ANSI/OSC escapes and resolve carriage-return overwrites. */
export function cleanTerminalText(s: string): string {
  const noEsc = s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\x1b[=>78DEHMc]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => (c === "\r" || c === "\n" ? c : ""));
  return noEsc
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => {
      const parts = l.split("\r");
      return parts[parts.length - 1] || parts.find((p) => p) || "";
    })
    .join("\n");
}

async function complete(system: string, user: string, maxTokens = 400): Promise<string> {
  const ai = getSettings().ai;
  const ch = new Channel<AiEvent>();
  ch.onmessage = () => {};
  const turn = await api.aiComplete(
    {
      provider: ai.provider,
      model: ai.model,
      baseUrl:
        ai.provider === "openai" ? ai.openaiBaseUrl : ai.provider === "ollama" ? ai.ollamaBaseUrl : null,
      system,
      messages: [{ role: "user", content: [{ type: "text", text: user }] }],
      tools: [],
      maxTokens,
    },
    ch,
  );
  return turn.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

// ---- 1. ask → command --------------------------------------------------------

export interface CommandSuggestion {
  command: string;
  explanation: string;
}

/** Parse the model's reply: the command (fenced or bare), plus `# why` lines. */
export function parseSuggestion(reply: string): CommandSuggestion {
  let text = reply.trim();
  const fence = /```[a-z]*\n([\s\S]*?)```/i.exec(text);
  const notes: string[] = [];
  if (fence) {
    const rest = text.replace(fence[0], "").trim();
    if (rest) notes.push(rest);
    text = fence[1];
  }
  const cmdLines: string[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith("#")) notes.push(l.replace(/^#+\s*/, ""));
    else cmdLines.push(l.replace(/^\$\s+/, ""));
  }
  return {
    command: cmdLines.join(" && "),
    explanation: notes.join(" ").replace(/\s+/g, " ").trim(),
  };
}

export async function askCommand(prompt: string, screen: string, where: string): Promise<CommandSuggestion> {
  const system = [
    "You turn a request into ONE shell command for the user's interactive terminal.",
    `The terminal is ${where}. The recent terminal screen is given for context (OS, cwd, prior errors).`,
    "Reply with exactly:",
    "line 1: the command — a single line, no backticks, no leading $",
    "line 2: `# ` followed by a one-sentence explanation in the user's language",
    "Prefer safe, read-only commands when the request allows. Never add sudo unless needed. Nothing else.",
  ].join("\n");
  const user = `Terminal screen:\n${screen.slice(-4000)}\n\nRequest: ${prompt}`;
  const s = parseSuggestion(await complete(system, user));
  if (!s.command) throw new Error(s.explanation || "The model didn't return a command.");
  return s;
}

// ---- 2. agent runs in the live terminal ---------------------------------------

const MARK = /\x1b\]697;(\d+)\x07/;
const TIMEOUT_MS = 120_000;
// One-time shell helper: prints the last exit status as an invisible OSC
// sequence, which marks where the command's output ends.
const HELPER = " __bd(){ printf '\\033]697;%d\\007' \"$?\"; }";

const RUN_IN_TERMINAL: AiTool = {
  name: "run_command",
  description:
    "Type a shell command into the user's live terminal and return its output and exit status. " +
    "It runs in their interactive shell — same working directory, environment and sudo session — and they watch it run. " +
    "`cd` and exported variables persist between calls. Commands that change state require approval. " +
    "Don't start full-screen or interactive programs (vim, less, top, htop, man), don't `exit`, and don't switch shells (su, ssh, bash) — " +
    "use flags like `--no-pager`, `-n 50`, `| head`. Time limit ~2 minutes.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string", description: "The exact shell command to run." } },
    required: ["command"],
    additionalProperties: false,
  },
};

export function terminalSystemPrompt(where: string): string {
  return [
    "You are BalauDeck's built-in assistant, working directly inside the user's terminal.",
    `The terminal is ${where}. Your run_command tool types commands into that live shell — the user sees each one run.`,
    "- Gather facts with read-only commands first; keep commands short and non-interactive.",
    "- Commands that change the server need the user's approval: say what you intend and why, and propose the smallest safe command.",
    "- If a command asks for a password (sudo), the user can type it in the terminal; the tool waits.",
    "- Be concise. Summarise findings; quote output only when it helps. End with a short, direct answer.",
  ].join("\n");
}

export interface TerminalIo {
  term: Terminal;
  /** Write raw input to the shell (PTY). */
  write: (data: string) => void;
  /** Subscribe to decoded shell output; returns an unsubscribe. */
  tap: (fn: (chunk: string) => void) => () => void;
  sessionId: () => string | null;
  /** Session id the __bd helper was defined in (mutable, owned by the panel). */
  helper: { current: string | null };
  /** Set while the agent is typing/running (suppresses the error chip). */
  busy: { current: boolean };
}

function waitFor(io: TerminalIo, ms: number): Promise<{ text: string; code: number | null }> {
  return new Promise((resolve) => {
    let text = "";
    const done = (code: number | null) => {
      clearTimeout(timer);
      off();
      resolve({ text, code });
    };
    const off = io.tap((chunk) => {
      text += chunk;
      if (text.length > 400_000) text = text.slice(-200_000);
      const m = MARK.exec(text);
      if (m) {
        text = text.slice(0, m.index);
        done(Number(m[1]));
      }
    });
    const timer = setTimeout(() => done(null), ms);
  });
}

/** Everything after the last echoed command line (the one ending in `__bd`). */
export function stripEcho(out: string): string {
  const lines = out.split("\n");
  let last = -1;
  lines.forEach((l, i) => {
    if (l.includes("__bd")) last = i;
  });
  return lines.slice(last + 1).join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function makeTerminalToolset(io: TerminalIo): Toolset {
  return {
    tools: [RUN_IN_TERMINAL],
    classify(call: ToolCall): ToolRisk {
      if (call.name !== "run_command") return { level: "write", reason: "unknown tool" };
      return classifyCommand(typeof call.input.command === "string" ? call.input.command : "");
    },
    async execute(call: ToolCall): Promise<ToolRunResult> {
      if (call.name !== "run_command") return { output: `Unknown tool: ${call.name}`, isError: true };
      const sid = io.sessionId();
      if (!sid) return { output: "No active terminal session — connect first.", isError: true };
      if (io.term.buffer.active.type === "alternate") {
        return {
          output:
            "A full-screen program (vim, less, top…) is open in the terminal. Ask the user to quit it, then try again.",
          isError: true,
        };
      }
      const command = (typeof call.input.command === "string" ? call.input.command : "").trim();
      if (!command) return { output: "Empty command.", isError: true };

      io.busy.current = true;
      try {
        // Clear whatever is half-typed at the prompt (Ctrl+E, Ctrl+U).
        io.write("\x05\x15");
        if (io.helper.current !== sid) {
          io.write(HELPER + "\r");
          io.helper.current = sid;
          await sleep(250);
        }
        const body = command.replace(/[;\s]+$/, "");
        const line = body.endsWith("&") ? `${body} __bd` : `${body}; __bd`;
        const wait = waitFor(io, TIMEOUT_MS);
        io.write(" " + line + "\r");
        const { text, code } = await wait;

        // Drop the echoed command (zsh may redraw it with the prompt, so cut
        // after the LAST line carrying the __bd suffix); keep what it printed.
        let out = stripEcho(cleanTerminalText(text));
        out = out.replace(/\s+$/, "");
        const CAP = 16000;
        if (out.length > CAP) out = out.slice(0, CAP) + `\n… (truncated ${out.length - CAP} more characters)`;

        if (code === null) {
          // The marker never came: still running, waiting for input, or the
          // shell changed (su/ssh) so the helper is gone.
          io.helper.current = null;
          return {
            output:
              (out || "(no output yet)") +
              "\n\n[still running after 2 minutes, or waiting for input — the user can see it in the terminal; press Ctrl+C there to stop it]",
            isError: true,
          };
        }
        return {
          output: `${out || "(no output)"}\n[exit ${code}]`,
          isError: code !== 0,
        };
      } finally {
        io.busy.current = false;
      }
    },
  };
}

// ---- 3. error detection ------------------------------------------------------

const ERROR_RX =
  /command not found|No such file or directory|Permission denied|cannot access|not permitted|\berror\b|\bfailed\b|fatal:|Traceback \(most recent call last\)|^E: |Segmentation fault|syntax error|Connection refused|Could not resolve|Unable to |is not recognized|unknown option|invalid option|usage:/im;

/** Does a command's output look like it failed? Ignores words the command itself
 *  searched for (e.g. `grep error app.log` printing "error" lines). */
export function looksLikeError(command: string, output: string): boolean {
  const m = ERROR_RX.exec(output);
  if (!m) return false;
  const word = m[0].toLowerCase().trim();
  if (command.toLowerCase().includes(word)) return false;
  if (/\b(grep|rg|ag|tail|cat|less|journalctl|dmesg|zgrep|awk|sed)\b/.test(command) && /\berror\b|\bfailed\b/i.test(word)) {
    return false;
  }
  return true;
}
