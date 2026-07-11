import type { SessionEvent } from "@cozycode/protocol";

export type ToolStatus = "running" | "done" | "error" | "denied";

/** A subagent's live/finished transcript, nested under its parent `task` call. */
export interface SubagentBlock {
  sessionId: string;
  agent: string;
  description: string;
  items: RenderItem[];
  status: "running" | "done" | "error";
  result?: string;
}

export type RenderItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string; streaming: boolean }
  | {
      id: string;
      kind: "tool";
      toolCallId: string;
      toolName: string;
      args: unknown;
      status: ToolStatus;
      result?: unknown;
      metadata?: Record<string, unknown>;
      /** Nested subagent transcript, present on `task` calls. */
      subagent?: SubagentBlock;
    }
  | { id: string; kind: "error"; text: string }
  | { id: string; kind: "system"; text: string }
  | {
      id: string;
      kind: "reasoning";
      reasoningId: string;
      text: string;
      streaming: boolean;
      durationMs?: number;
    };

let counter = 0;
export const nextId = () => `i${counter++}`;

export function userItem(text: string): RenderItem {
  return { id: nextId(), kind: "user", text };
}

/** A non-user, non-assistant notice line (e.g. a mode transition marker). */
export function systemItem(text: string): RenderItem {
  return { id: nextId(), kind: "system", text };
}

/**
 * Fold one session event into the current turn's items. The App renders
 * finalized turns via Ink's <Static> and the active turn dynamically, so this
 * only needs to track one turn's worth of interleaved text and tool calls.
 */
export function foldTurn(items: RenderItem[], event: SessionEvent): RenderItem[] {
  switch (event.type) {
    case "text-delta": {
      const last = items[items.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
      }
      return [...items, { id: nextId(), kind: "assistant", text: event.text, streaming: true }];
    }
    case "reasoning-start":
      return [
        ...items,
        { id: nextId(), kind: "reasoning", reasoningId: event.id, text: "", streaming: true },
      ];
    case "reasoning-delta":
      return items.map((it) =>
        it.kind === "reasoning" && it.reasoningId === event.id && it.streaming
          ? { ...it, text: it.text + event.text }
          : it,
      );
    case "reasoning-end":
      // Only close the still-streaming block. Some adapters (e.g. openai-compatible
      // / DeepSeek) reuse one reasoning id ("reasoning-0") for every block, so
      // matching on id alone would overwrite every prior block's duration.
      return items.map((it) =>
        it.kind === "reasoning" && it.reasoningId === event.id && it.streaming
          ? { ...it, streaming: false, durationMs: event.durationMs }
          : it,
      );
    case "tool-call-start":
      return [
        ...items,
        {
          id: nextId(),
          kind: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          status: "running",
        },
      ];
    case "tool-result":
      return items.map((it) =>
        it.kind === "tool" && it.toolCallId === event.toolCallId
          ? { ...it, status: statusFor(event.isError, event.result), result: event.result, metadata: event.metadata }
          : it,
      );
    case "subagent-start":
      return items.map((it) =>
        it.kind === "tool" && it.toolCallId === event.toolCallId
          ? {
              ...it,
              subagent: {
                sessionId: event.sessionId,
                agent: event.agent,
                description: event.description,
                items: [],
                status: "running",
              },
            }
          : it,
      );
    case "subagent-event":
      return items.map((it) =>
        it.kind === "tool" && it.toolCallId === event.toolCallId && it.subagent
          ? { ...it, subagent: { ...it.subagent, items: foldTurn(it.subagent.items, event.event) } }
          : it,
      );
    case "subagent-finish":
      return items.map((it) =>
        it.kind === "tool" && it.toolCallId === event.toolCallId && it.subagent
          ? {
              ...it,
              subagent: {
                ...it.subagent,
                status: event.isError ? "error" : "done",
                result: event.result,
                items: finalizeTurn(it.subagent.items),
              },
            }
          : it,
      );
    case "error":
      return [...finalizeTurn(items, "Did not complete."), { id: nextId(), kind: "error", text: event.message }];
    case "finish":
      return finalizeTurn(items, event.reason === "abort" ? "Stopped." : "Did not complete.");
    default:
      return items;
  }
}

/** Mark live presentation items as complete when a turn ends. */
export function finalizeTurn(items: RenderItem[], incompleteToolResult = "Did not complete."): RenderItem[] {
  return items.map((it) => {
    if (it.kind === "assistant" || it.kind === "reasoning") return { ...it, streaming: false };
    if (it.kind === "tool" && it.status === "running") {
      return { ...it, status: "error", result: incompleteToolResult };
    }
    return it;
  });
}

function statusFor(isError: boolean, result: unknown): ToolStatus {
  if (isError) return "error";
  if (result && typeof result === "object" && (result as { denied?: boolean }).denied) {
    return "denied";
  }
  return "done";
}
