import type { SessionEvent } from "@cozycode/protocol";
import type { SessionEventEnvelope } from "../../shared/ipc.ts";

type ScheduleFrame = (callback: () => void) => number;
type CancelFrame = (handle: number) => void;

function batchable(event: SessionEvent): boolean {
  if (event.type === "text-delta" || event.type === "reasoning-delta") return true;
  return event.type === "subagent-event" && batchable(event.event);
}

function mergeEvents(previous: SessionEvent, next: SessionEvent): SessionEvent | null {
  if (previous.type === "text-delta" && next.type === "text-delta") {
    return { type: "text-delta", text: previous.text + next.text };
  }
  if (
    previous.type === "reasoning-delta" &&
    next.type === "reasoning-delta" &&
    previous.id === next.id
  ) {
    return { type: "reasoning-delta", id: previous.id, text: previous.text + next.text };
  }
  if (
    previous.type === "subagent-event" &&
    next.type === "subagent-event" &&
    previous.toolCallId === next.toolCallId &&
    previous.sessionId === next.sessionId
  ) {
    const event = mergeEvents(previous.event, next.event);
    return event ? { ...previous, event } : null;
  }
  return null;
}

function mergeEnvelopes(
  previous: SessionEventEnvelope,
  next: SessionEventEnvelope,
): SessionEventEnvelope | null {
  if (previous.sessionId !== next.sessionId) return null;
  const event = mergeEvents(previous.event, next.event);
  return event ? { sessionId: previous.sessionId, event } : null;
}

/** Coalesce renderer-only stream fragments to at most one state update per animation frame. */
export function createSessionEventBatcher(
  apply: (envelope: SessionEventEnvelope) => void,
  schedule: ScheduleFrame = (callback) => requestAnimationFrame(callback),
  cancel: CancelFrame = (handle) => cancelAnimationFrame(handle),
) {
  let queued: SessionEventEnvelope[] = [];
  let frame: number | null = null;

  const drain = () => {
    frame = null;
    const pending = queued;
    queued = [];
    for (const envelope of pending) apply(envelope);
  };

  const flush = () => {
    if (frame !== null) cancel(frame);
    drain();
  };

  const push = (envelope: SessionEventEnvelope) => {
    if (!batchable(envelope.event)) {
      flush();
      apply(envelope);
      return;
    }

    const last = queued.at(-1);
    const merged = last ? mergeEnvelopes(last, envelope) : null;
    if (merged) queued[queued.length - 1] = merged;
    else queued.push(envelope);
    if (frame === null) frame = schedule(drain);
  };

  return {
    push,
    flush,
    dispose: flush,
  };
}
