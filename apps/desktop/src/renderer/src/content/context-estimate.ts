import type { TranscriptItem } from "../transcript.ts";

export interface ContextCategory {
  label: string;
  tokens: number;
}

export interface ContextEstimate {
  categories: ContextCategory[];
  total: number;
}

/** Very rough token count: ~4 chars per token (English-ish average). */
function tokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function jsonLen(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Estimated tokens contributed by a single item, by category. */
function itemTokens(item: TranscriptItem): { messages: number; reasoning: number; tools: number } {
  switch (item.kind) {
    case "user":
    case "assistant":
    case "system":
    case "error":
      return { messages: tokens(item.text), reasoning: 0, tools: 0 };
    case "reasoning":
      return { messages: 0, reasoning: tokens(item.text), tools: 0 };
    case "tool":
      return { messages: 0, reasoning: 0, tools: Math.ceil((jsonLen(item.args) + jsonLen(item.result)) / 4) };
  }
}

/** Total estimated tokens across a (possibly nested) subagent transcript. */
function sumNested(items: TranscriptItem[]): number {
  let total = 0;
  for (const item of items) {
    const t = itemTokens(item);
    total += t.messages + t.reasoning + t.tools;
    if (item.kind === "tool" && item.subagent) total += sumNested(item.subagent.items);
  }
  return total;
}

/**
 * Estimate how the current context breaks down by category, purely from the
 * rendered transcript. This is a heuristic (chars/4) — it does NOT match the
 * model's measured token accounting and omits the hidden system prompt. It's
 * for a rough "what's filling the window" sense, not billing. Subagent work is
 * rolled up into its own category (subagents run as separate child sessions, so
 * their tokens don't share the parent's window, but the estimate surfaces them).
 */
export function estimateContext(items: TranscriptItem[]): ContextEstimate {
  let messages = 0;
  let reasoning = 0;
  let tools = 0;
  let subagents = 0;

  for (const item of items) {
    const t = itemTokens(item);
    messages += t.messages;
    reasoning += t.reasoning;
    tools += t.tools;
    if (item.kind === "tool" && item.subagent) subagents += sumNested(item.subagent.items);
  }

  const categories: ContextCategory[] = [
    { label: "Messages", tokens: messages },
    { label: "Reasoning", tokens: reasoning },
    { label: "Tool calls", tokens: tools },
    { label: "Subagents", tokens: subagents },
  ].filter((c) => c.tokens > 0);

  return { categories, total: messages + reasoning + tools + subagents };
}
