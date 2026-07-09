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
    }
  | { id: string; kind: "error"; text: string }
  | { id: string; kind: "system"; text: string };

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
    case "finish":
      // Stop the streaming indicator on the last assistant message.
      return items.map((it, i) =>
        i === items.length - 1 && it.kind === "assistant" ? { ...it, streaming: false } : it,
      );
    default:
      return items; // session-start, permission-asked/replied, step-finish, mode-change are not rendered directly
  }
}

function statusFor(isError: boolean, result: unknown): ToolStatus {
  if (isError) return "error";
  if (result && typeof result === "object" && (result as { denied?: boolean }).denied) {
    return "denied";
  }
  return "done";
}
