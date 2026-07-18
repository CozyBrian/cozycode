import { describe, expect, test } from "bun:test";
import type {
  PermissionRequest,
  QuestionRequest,
  SessionEvent,
} from "@cozycode/protocol";
import type { SessionEventRecord, SessionMetadata } from "@cozycode/sessions";
import {
  createTuiAppStore,
  selectActiveView,
  selectAggregatePendingCount,
  selectRenderItems,
} from "../src/store/index.ts";

describe("TUI app store addressed events", () => {
  test("exposes cached snapshots and direct external-store subscriptions", () => {
    const store = createTuiAppStore([metadata("session")]);
    const initial = store.getSnapshot();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications += 1);

    expect(store.getSnapshot()).toBe(initial);
    expect(selectRenderItems(initial)).toBe(selectRenderItems(initial));
    store.setActiveSession("session");
    expect(store.getSnapshot()).not.toBe(initial);
    expect(notifications).toBe(1);
    unsubscribe();
    store.updateDraft("session", "ignored notification");
    expect(notifications).toBe(1);
  });

  test("keeps interleaved session streams out of the visible session", () => {
    const store = createTuiAppStore([metadata("one"), metadata("two")]);
    store.setActiveSession("one");
    store.beginOptimisticTurn("one", "turn-one", "first");
    store.beginOptimisticTurn("two", "turn-two", "second");

    store.applyHostEvent(hostEvent("one", 1, "turn-one", { type: "text-delta", text: "A" }));
    store.applyHostEvent(hostEvent("two", 1, "turn-two", { type: "text-delta", text: "B" }));
    store.applyHostEvent(hostEvent("one", 2, "turn-one", { type: "text-delta", text: "C" }));

    expect(selectActiveView(store.getSnapshot())).toBe(store.getSnapshot().viewsBySessionID.one);
    expect(assistantText(selectRenderItems(store.getSnapshot()))).toBe("AC");
    expect(assistantText(selectRenderItems(store.getSnapshot(), "two"))).toBe("B");
    expect(store.getSnapshot().viewsBySessionID.one?.lastEventSeq).toBe(2);
    expect(store.getSnapshot().viewsBySessionID.two?.lastEventSeq).toBe(1);
  });

  test("marks background completion and errors unread until activation", () => {
    const store = createTuiAppStore([metadata("visible"), metadata("done"), metadata("failed")]);
    store.setActiveSession("visible");
    store.beginOptimisticTurn("done", "done-turn", "work");
    store.applyHostEvent(hostEvent("done", 1, "done-turn", { type: "text-delta", text: "complete" }));
    store.applyHostEvent(hostEvent("done", 2, "done-turn", {
      type: "finish",
      reason: "stop",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    }));
    store.beginOptimisticTurn("failed", "failed-turn", "work");
    store.applyHostEvent(hostEvent("failed", 1, "failed-turn", { type: "error", message: "boom" }));

    expect(store.getSnapshot().viewsBySessionID.done?.unread).toBe("completion");
    expect(store.getSnapshot().viewsBySessionID.failed?.unread).toBe("error");
    expect(store.getSnapshot().viewsBySessionID.done?.usage).toEqual({
      turn: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      total: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
    store.setActiveSession("done");
    expect(store.getSnapshot().viewsBySessionID.done?.unread).toBeNull();
    expect(store.getSnapshot().viewsBySessionID.failed?.unread).toBe("error");
  });

  test("isolates addressed permission and question queues", () => {
    const store = createTuiAppStore([metadata("one"), metadata("two")]);
    store.beginOptimisticTurn("one", "turn-one", "first");
    store.beginOptimisticTurn("two", "turn-two", "second");
    const permission: PermissionRequest = {
      id: "per_1",
      sessionId: "one",
      permission: "edit",
      patterns: ["file.ts"],
      metadata: {},
      always: [],
    };
    const question: QuestionRequest = {
      id: "qst_1",
      sessionId: "two",
      questions: [{ question: "Which?", header: "Choice", options: [] }],
    };

    store.applyHostEvent(hostEvent("one", 1, "turn-one", { type: "permission-asked", request: permission }));
    store.applyHostEvent(hostEvent("two", 1, "turn-two", { type: "question-asked", request: question }));

    expect(store.getSnapshot().viewsBySessionID.one?.pendingPermissions.map((item) => item.id)).toEqual(["per_1"]);
    expect(store.getSnapshot().viewsBySessionID.one?.pendingQuestions).toEqual([]);
    expect(store.getSnapshot().viewsBySessionID.two?.pendingQuestions.map((item) => item.id)).toEqual(["qst_1"]);
    expect(selectAggregatePendingCount(store.getSnapshot())).toBe(2);

    store.applyHostEvent(hostEvent("one", 2, "turn-one", {
      type: "permission-replied",
      requestId: "per_1",
      reply: "once",
    }));
    expect(selectAggregatePendingCount(store.getSnapshot())).toBe(1);
    expect(store.getSnapshot().viewsBySessionID.two?.pendingQuestions).toHaveLength(1);
  });

  test("abort and error finalize only their owning turn", () => {
    const store = createTuiAppStore([metadata("session")]);
    store.setActiveSession("session");
    store.beginOptimisticTurn("session", "aborted", "stop me");
    store.beginOptimisticTurn("session", "failed", "fail me");
    store.applyHostEvent(hostEvent("session", 1, "aborted", {
      type: "tool-call-start",
      toolCallId: "tool-one",
      toolName: "edit",
      args: {},
    }));
    store.applyHostEvent(hostEvent("session", 2, "failed", { type: "text-delta", text: "partial" }));

    store.applyHostEvent(hostEvent("session", 3, "aborted", { type: "finish", reason: "abort" }));
    let view = store.getSnapshot().viewsBySessionID.session!;
    expect(view.activeTurnOrder).toEqual(["failed"]);
    expect(view.activeTurnItemsByID.failed?.find((item) => item.kind === "assistant")).toMatchObject({
      text: "partial",
      streaming: true,
    });
    expect(view.stableItems.find((item) => item.kind === "tool")).toMatchObject({
      toolCallId: "tool-one",
      status: "error",
      result: "Stopped.",
    });

    store.applyHostEvent(hostEvent("session", 4, "failed", { type: "error", message: "failed" }));
    view = store.getSnapshot().viewsBySessionID.session!;
    expect(view.activeTurnOrder).toEqual([]);
    expect(view.stableItems.find((item) => item.kind === "assistant")).toMatchObject({ streaming: false });
    expect(view.stableItems.at(-1)).toMatchObject({ kind: "error", text: "failed" });
  });

  test("status errors finalize an optimistic turn that failed before durable events", () => {
    const store = createTuiAppStore([metadata("session")]);
    store.beginOptimisticTurn("session", "turn", "prompt");
    store.applyHostEvent({
      type: "status",
      sessionID: "session",
      turnID: "turn",
      status: "error",
      at: 5,
      error: "could not start",
    });

    const view = store.getSnapshot().viewsBySessionID.session!;
    expect(view.activeTurnOrder).toEqual([]);
    expect(view.stableItems.at(-1)).toMatchObject({ kind: "error", text: "could not start" });
    expect(view.unread).toBe("error");
  });
});

function metadata(id: string): SessionMetadata {
  return {
    id,
    title: id,
    workspace: "/workspace",
    model: { providerID: "test", modelID: "model" },
    mode: "build",
    createdAt: 1,
    updatedAt: 1,
    turnCount: 0,
  };
}

function hostEvent(
  sessionID: string,
  seq: number,
  turnID: string,
  event: SessionEvent,
) {
  const record: SessionEventRecord = { sessionID, seq, at: seq, turnID, event };
  return { type: "session-event" as const, sessionID, turnID, event, record };
}

function assistantText(items: readonly { kind: string; text?: string }[]): string | undefined {
  return items.find((item) => item.kind === "assistant")?.text;
}
