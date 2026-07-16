import { describe, expect, test } from "bun:test";
import type { SessionEventEnvelope } from "../src/shared/ipc.ts";
import { createSessionEventBatcher } from "../src/renderer/src/event-buffer.ts";

function envelope(
  event: SessionEventEnvelope["event"],
  sessionId = "session-1",
): SessionEventEnvelope {
  return { sessionId, event };
}

describe("renderer event batching", () => {
  test("coalesces contiguous text deltas on the next frame", () => {
    const applied: SessionEventEnvelope[] = [];
    let runFrame: (() => void) | undefined;
    const batcher = createSessionEventBatcher(
      (event) => applied.push(event),
      (callback) => {
        runFrame = callback;
        return 1;
      },
      () => {},
    );

    batcher.push(envelope({ type: "text-delta", text: "hello " }));
    batcher.push(envelope({ type: "text-delta", text: "world" }));
    expect(applied).toEqual([]);

    runFrame?.();
    expect(applied).toEqual([envelope({ type: "text-delta", text: "hello world" })]);
  });

  test("flushes pending deltas before an ordering-sensitive event", () => {
    const applied: SessionEventEnvelope[] = [];
    let cancelled = false;
    const batcher = createSessionEventBatcher(
      (event) => applied.push(event),
      () => 1,
      () => {
        cancelled = true;
      },
    );

    batcher.push(envelope({ type: "reasoning-delta", id: "r1", text: "thinking" }));
    batcher.push(envelope({ type: "reasoning-end", id: "r1" }));

    expect(cancelled).toBe(true);
    expect(applied.map(({ event }) => event.type)).toEqual([
      "reasoning-delta",
      "reasoning-end",
    ]);
  });

  test("does not merge interleaved sessions or distinct subagent streams", () => {
    const applied: SessionEventEnvelope[] = [];
    let runFrame: (() => void) | undefined;
    const batcher = createSessionEventBatcher(
      (event) => applied.push(event),
      (callback) => {
        runFrame = callback;
        return 1;
      },
      () => {},
    );

    batcher.push(envelope({ type: "text-delta", text: "a" }, "a"));
    batcher.push(envelope({ type: "text-delta", text: "b" }, "b"));
    batcher.push(
      envelope({
        type: "subagent-event",
        toolCallId: "tool-1",
        sessionId: "child-1",
        event: { type: "text-delta", text: "child" },
      }),
    );
    runFrame?.();

    expect(applied).toHaveLength(3);
    expect(applied.map(({ sessionId }) => sessionId)).toEqual(["a", "b", "session-1"]);
  });
});
