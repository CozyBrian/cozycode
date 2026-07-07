import type { SessionEvent } from "@cozycode/protocol";

export type ToolStatus = "running" | "done" | "error" | "denied";

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
    }
  | { id: string; kind: "error"; text: string };

let counter = 0;
export const nextId = () => `i${counter++}`;

export function userItem(text: string): RenderItem {
  return { id: nextId(), kind: "user", text };
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
          ? { ...it, status: statusFor(event.isError, event.result), result: event.result }
          : it,
      );
    case "error":
      return [...items, { id: nextId(), kind: "error", text: event.message }];
    default:
      return items;
  }
}

/** Mark the trailing assistant message as no longer streaming (turn ended). */
export function finalizeTurn(items: RenderItem[]): RenderItem[] {
  return items.map((it) => (it.kind === "assistant" ? { ...it, streaming: false } : it));
}

function statusFor(isError: boolean, result: unknown): ToolStatus {
  if (isError) return "error";
  if (result && typeof result === "object" && (result as { denied?: boolean }).denied) {
    return "denied";
  }
  return "done";
}
