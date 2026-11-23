// Token usage + rough cost for the AI chat footer and per-answer stats.
//
// Prices are Anthropic list prices per million tokens, matched by model
// family, so a new release (e.g. claude-opus-5-5) still gets an estimate from
// its family. Always shown as "≈" — the provider's console is the bill.

import type { AiProvider } from "../settings";

const FAMILY: { match: RegExp; inPerM: number; outPerM: number }[] = [
  { match: /fable|mythos/, inPerM: 10, outPerM: 50 },
  { match: /opus/, inPerM: 5, outPerM: 25 },
  { match: /sonnet/, inPerM: 3, outPerM: 15 },
  { match: /haiku/, inPerM: 1, outPerM: 5 },
];

/** Estimated USD cost, or null when we can't say (unknown/OpenAI-compatible).
 *  Local Ollama is free. */
export function estimateCost(
  provider: AiProvider,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (provider === "ollama") return 0;
  if (provider !== "anthropic") return null;
  const f = FAMILY.find((p) => p.match.test(model));
  if (!f) return null;
  return (inputTokens * f.inPerM + outputTokens * f.outPerM) / 1_000_000;
}

/** 1234 → "1.2k", 1_500_000 → "1.5M". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtCost(usd: number | null): string {
  if (usd === null) return "";
  if (usd === 0) return "free";
  if (usd < 0.01) return "<$0.01";
  return `≈$${usd.toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Stats for one run (one user message → final answer). */
export interface RunStats {
  model: string;
  steps: number;
  tools: number;
  inputTokens: number;
  outputTokens: number;
  /** Input tokens of the last call ≈ how much context the chat now carries. */
  context: number;
  ms: number;
}

export const emptyRun = (model: string): RunStats => ({
  model,
  steps: 0,
  tools: 0,
  inputTokens: 0,
  outputTokens: 0,
  context: 0,
  ms: 0,
});
