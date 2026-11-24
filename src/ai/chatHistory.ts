// Saved AI chats, per connection ("scope": `ssh:user@host`, `db:…`, `local`).
//
// Each scope keeps the open chat plus a short list of earlier ones, in
// localStorage. Tool outputs are trimmed before saving: they are the bulk of a
// chat, and a resumed chat only needs enough of them to make sense.

import type { AiBlock, AiMessage } from "./types";
import type { ToolRunResult } from "./tool";
import type { RunStats } from "./usage";

export interface ChatSession {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
  costKnown: boolean;
  context: number;
}

export interface SavedChat {
  id: string;
  title: string;
  updated: number;
  messages: AiMessage[];
  results: Record<string, ToolRunResult>;
  runMeta: Record<number, RunStats>;
  session: ChatSession;
}

interface Store {
  current: SavedChat | null;
  past: SavedChat[];
}

const PREFIX = "balaudeck.aiChats.";
const MAX_PAST = 20;
const MAX_TOOL_CHARS = 4000;
const MAX_BYTES = 1_500_000;

const keyOf = (scope: string) => PREFIX + scope;

function read(scope: string): Store {
  try {
    const raw = localStorage.getItem(keyOf(scope));
    if (raw) {
      const s = JSON.parse(raw) as Store;
      return { current: s.current ?? null, past: Array.isArray(s.past) ? s.past : [] };
    }
  } catch {
    /* corrupt or unavailable — start fresh */
  }
  return { current: null, past: [] };
}

function write(scope: string, s: Store) {
  let past = s.past.slice(0, MAX_PAST);
  for (;;) {
    const json = JSON.stringify({ current: s.current, past });
    if (json.length <= MAX_BYTES || past.length === 0) {
      try {
        localStorage.setItem(keyOf(scope), json);
      } catch {
        if (past.length) {
          past = past.slice(0, -1);
          continue;
        }
      }
      return;
    }
    past = past.slice(0, -1); // drop the oldest until it fits
  }
}

const clip = (s: string) =>
  s.length > MAX_TOOL_CHARS ? s.slice(0, MAX_TOOL_CHARS) + `\n… (${s.length - MAX_TOOL_CHARS} more chars not saved)` : s;

function trimBlock(b: AiBlock): AiBlock {
  return b.type === "tool_result" ? { ...b, content: clip(b.content) } : b;
}

/** First user line, shortened — the chat's name in the history list. */
export function chatTitle(messages: AiMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const t = m.content.find((b) => b.type === "text");
    if (t && t.type === "text" && t.text.trim()) {
      const line = t.text.trim().replace(/\s+/g, " ");
      return line.length > 60 ? line.slice(0, 57) + "…" : line;
    }
  }
  return "Chat";
}

export function newChatId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Copy of the chat with tool output trimmed, ready to store. */
function compact(c: SavedChat): SavedChat {
  const results: Record<string, ToolRunResult> = {};
  for (const [id, r] of Object.entries(c.results)) {
    results[id] = { ...r, output: clip(r.output) };
  }
  return {
    ...c,
    messages: c.messages.map((m) => ({ ...m, content: m.content.map(trimBlock) })),
    results,
  };
}

export function loadCurrent(scope: string): SavedChat | null {
  return read(scope).current;
}

export function listPast(scope: string): SavedChat[] {
  return read(scope).past;
}

/** Save the open chat (an empty one clears it). */
export function saveCurrent(scope: string, chat: SavedChat | null) {
  const s = read(scope);
  const current = chat && chat.messages.length ? compact(chat) : null;
  write(scope, { current, past: s.past.filter((p) => p.id !== current?.id) });
}

/** Move the open chat into the history list (New chat). */
export function archiveCurrent(scope: string) {
  const s = read(scope);
  if (!s.current) return;
  write(scope, { current: null, past: [s.current, ...s.past.filter((p) => p.id !== s.current!.id)] });
}

/** Reopen an earlier chat; the open one goes back to the list. */
export function reopen(scope: string, id: string): SavedChat | null {
  const s = read(scope);
  const chat = s.past.find((p) => p.id === id) ?? null;
  if (!chat) return null;
  const rest = s.past.filter((p) => p.id !== id);
  write(scope, { current: chat, past: s.current ? [s.current, ...rest] : rest });
  return chat;
}

export function deletePast(scope: string, id: string) {
  const s = read(scope);
  write(scope, { ...s, past: s.past.filter((p) => p.id !== id) });
}

export function clearAll(scope: string) {
  try {
    localStorage.removeItem(keyOf(scope));
  } catch {
    /* ignore */
  }
}
