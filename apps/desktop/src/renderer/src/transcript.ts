import type { SessionEvent } from "@cozycode/protocol";

export type ToolStatus = "running" | "done" | "error" | "denied";

export type TranscriptItem =
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
const nextId = () => `i${counter++}`;

export function userItem(text: string): TranscriptItem {
  return { id: nextId(), kind: "user", text };
}

/** Fold one session event into the transcript, returning a new array. */
export function foldEvent(items: TranscriptItem[], event: SessionEvent): TranscriptItem[] {
  switch (event.type) {
    case "text-delta": {
      const last = items[items.length - 1];
      if (last && last.kind === "assistant" && last.streaming) {
        const updated = { ...last, text: last.text + event.text };
        return [...items.slice(0, -1), updated];
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
      return items.map((it) =>
        it.kind === "reasoning" && it.reasoningId === event.id
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
          ? {
              ...it,
              status: statusFor(event.isError, event.result),
              result: event.result,
              metadata: event.metadata,
            }
          : it,
      );
    case "error":
      return [...items, { id: nextId(), kind: "error", text: event.message }];
    case "finish":
      return items.map((it) =>
        it.kind === "assistant" || it.kind === "reasoning" ? { ...it, streaming: false } : it,
      );
    default:
      return items; // session-start, permission-asked/replied, step-finish, mode-change, effort-change are not rendered directly
  }
}

function statusFor(isError: boolean, result: unknown): ToolStatus {
  if (isError) return "error";
  if (result && typeof result === "object" && (result as { denied?: boolean }).denied) {
    return "denied";
  }
  return "done";
}
