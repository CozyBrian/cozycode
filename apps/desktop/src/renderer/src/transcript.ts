import type { SessionEvent } from "@cozycode/protocol";

export type ToolStatus = "running" | "done" | "error" | "denied";

export type TranscriptItem =
  | { id: string; kind: "user"; text: string; turnId?: string }
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
      /** Present on `task` calls; drilled into read-only via the renderer. */
      subagent?: {
        sessionId: string;
        agent: string;
        description: string;
        status: "running" | "done" | "error";
        result?: string;
        toolCount: number;
        /** The child's folded transcript, for the drill-in view + live status. */
        items: TranscriptItem[];
      };
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

export function userItem(text: string, turnId?: string): TranscriptItem {
  return { id: turnId ? `turn:${turnId}` : nextId(), kind: "user", text, turnId };
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
          ? {
              ...it,
              status: statusFor(event.isError, event.result),
              result: event.result,
              metadata: event.metadata,
            }
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
                status: "running",
                toolCount: 0,
                items: [],
              },
            }
          : it,
      );
    case "subagent-event":
      return items.map((it) =>
        it.kind === "tool" && it.toolCallId === event.toolCallId && it.subagent
          ? {
              ...it,
              subagent: {
                ...it.subagent,
                toolCount:
                  it.subagent.toolCount + (event.event.type === "tool-call-start" ? 1 : 0),
                items: foldEvent(it.subagent.items, event.event),
              },
            }
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
                items: it.subagent.items.map((x) =>
                  x.kind === "assistant" || x.kind === "reasoning" ? { ...x, streaming: false } : x,
                ),
              },
            }
          : it,
      );
    case "error":
      return [...finalizeTranscript(items, "Did not complete."), { id: nextId(), kind: "error", text: event.message }];
    case "finish":
      return finalizeTranscript(items, event.reason === "abort" ? "Stopped." : "Did not complete.");
    default:
      return items; // session-start, permission/question control events, step-finish, mode/effort-change are not rendered directly
  }
}

/** Close every live presentation item when a turn ends without its usual result event. */
function finalizeTranscript(items: TranscriptItem[], incompleteToolResult: string): TranscriptItem[] {
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
