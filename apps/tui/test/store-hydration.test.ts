import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@cozycode/protocol";
import type {
  ArchivedSession,
  RecentArchivedSession,
  SessionEventRecord,
  SessionMetadata,
  SessionTurn,
} from "@cozycode/sessions";
import {
  createTuiAppStore,
  selectOrderedSessions,
  selectRenderItems,
} from "../src/store/index.ts";

describe("TUI app store hydration", () => {
  test("merges user turns at boundary sequences and sorts visible replay records", () => {
    const archived = archive(
      "session",
      [
        turn("session", "second", 2, 4, "completed", "second prompt"),
        turn("session", "first", 1, 1, "completed", "first prompt"),
      ],
      [
        record("session", 7, "second", { type: "finish", reason: "stop" }),
        record("session", 2, "first", { type: "text-delta", text: " world" }),
        record("session", 4, "second", { type: "reasoning-start", id: "reasoning-0" }),
        record("session", 1, "first", { type: "text-delta", text: "hello" }),
        record("session", 5, "second", {
          type: "reasoning-delta",
          id: "reasoning-0",
          text: "think",
        }),
        record("session", 6, "second", {
          type: "reasoning-delta",
          id: "reasoning-0",
          text: "ing",
        }),
        record("session", 3, "first", { type: "finish", reason: "stop" }),
      ],
    );
    const store = createTuiAppStore();

    expect(store.hydrate(archived)).toBe(true);
    expect(selectRenderItems(store.getSnapshot(), "session").map((item) => [item.kind, item.kind === "user" || item.kind === "assistant" || item.kind === "reasoning" ? item.text : ""])).toEqual([
      ["user", "first prompt"],
      ["assistant", "hello world"],
      ["user", "second prompt"],
      ["reasoning", "thinking"],
    ]);
    expect(store.getSnapshot().viewsBySessionID.session?.lastEventSeq).toBe(7);
  });

  test("derives stable render IDs from session, turn, and first event identities", () => {
    const archived = archive(
      "stable/session",
      [turn("stable/session", "turn/one", 1, 1, "completed", "prompt")],
      [
        record("stable/session", 1, "turn/one", { type: "text-delta", text: "A" }),
        record("stable/session", 2, "turn/one", { type: "text-delta", text: "B" }),
        record("stable/session", 3, "turn/one", { type: "finish", reason: "stop" }),
      ],
    );
    const first = createTuiAppStore();
    const second = createTuiAppStore();
    first.hydrate(archived);
    second.hydrate(structuredClone(archived));

    const firstItems = selectRenderItems(first.getSnapshot(), "stable/session");
    const secondItems = selectRenderItems(second.getSnapshot(), "stable/session");
    expect(firstItems.map((item) => item.id)).toEqual(secondItems.map((item) => item.id));
    expect(firstItems.map((item) => item.id)).toEqual([
      "session:stable%2Fsession/turn:turn%2Fone/user",
      "session:stable%2Fsession/turn:turn%2Fone/event:1/assistant",
    ]);
  });

  test("rejects late stale hydration without losing newer events or draft revisions", () => {
    const initial = archive(
      "session",
      [turn("session", "turn", 1, 1, "running", "prompt")],
      [record("session", 1, "turn", { type: "text-delta", text: "old" })],
      { text: "archive draft", revision: 1 },
    );
    const store = createTuiAppStore();
    store.hydrate(initial);
    store.updateDraft("session", "local draft", 1);
    store.applyHostEvent(hostEvent("session", 2, "turn", { type: "text-delta", text: " new" }));

    expect(store.hydrate(initial)).toBe(false);
    const view = store.getSnapshot().viewsBySessionID.session!;
    expect(selectRenderItems(store.getSnapshot(), "session").find((item) => item.kind === "assistant")).toMatchObject({
      text: "old new",
    });
    expect(view.lastEventSeq).toBe(2);
    expect(view.draft).toEqual({ text: "local draft", revision: 2 });
    expect(store.clearDraft("session", 1).applied).toBe(false);
  });

  test("force-replaces a session with a lower visible sequence after undo", () => {
    const full = archive(
      "session",
      [
        turn("session", "one", 1, 1, "completed", "one"),
        turn("session", "two", 2, 3, "completed", "two"),
      ],
      [
        record("session", 1, "one", { type: "text-delta", text: "first" }),
        record("session", 2, "one", { type: "finish", reason: "stop" }),
        record("session", 3, "two", { type: "text-delta", text: "second" }),
        record("session", 4, "two", { type: "finish", reason: "stop" }),
      ],
      { text: "archived draft", revision: 1 },
    );
    const undone = archive(
      "session",
      [turn("session", "one", 1, 1, "completed", "one")],
      [
        record("session", 1, "one", { type: "text-delta", text: "first" }),
        record("session", 2, "one", { type: "finish", reason: "stop" }),
      ],
      { text: "stale undo draft", revision: 1 },
    );
    const store = createTuiAppStore();
    store.hydrate(full);
    store.updateDraft("session", "newer local draft", 1);

    store.replaceSession(undone, {
      rollbackCursor: {
        revision: 1,
        boundaryTurnID: "two",
        boundaryOrdinal: 2,
        boundarySeq: 3,
        visibleTurnCount: 1,
        originalTurnCount: 2,
      },
    });

    const view = store.getSnapshot().viewsBySessionID.session!;
    expect(view.lastEventSeq).toBe(2);
    expect(view.draft).toEqual({ text: "newer local draft", revision: 2 });
    expect(view.rollbackCursor).toMatchObject({ boundaryTurnID: "two", visibleTurnCount: 1 });
    expect(selectRenderItems(store.getSnapshot(), "session").filter((item) => item.kind === "user").map((item) => item.text)).toEqual(["one"]);
  });

  test("marks bounded hydration and omits turn rows older than the loaded event window", () => {
    const recent = {
      metadata: { ...metadata("session", 10), turnCount: 3 },
      turns: [
        summary("session", "one", 1, 1, "completed", "one"),
        summary("session", "two", 2, 3, "completed", "two"),
        summary("session", "three", 3, 5, "completed", "three"),
      ],
      events: [
        record("session", 4, "two", { type: "finish", reason: "stop" }),
        record("session", 5, "three", { type: "text-delta", text: "latest" }),
        record("session", 6, "three", { type: "finish", reason: "stop" }),
      ],
      window: {
        eventsOmitted: true,
        turnsOmitted: true,
        firstEventSeq: 4,
        lastEventSeq: 6,
      },
    } satisfies RecentArchivedSession;
    const store = createTuiAppStore();

    store.hydrate(recent);

    const view = store.getSnapshot().viewsBySessionID.session!;
    expect(view.earlierEventsOmitted).toBe(true);
    expect(view.earlierTurnsOmitted).toBe(true);
    expect(selectRenderItems(store.getSnapshot(), "session").filter((item) => item.kind === "user").map((item) => item.text)).toEqual([
      "two",
      "three",
    ]);
    expect(selectRenderItems(store.getSnapshot(), "session").some((item) => item.kind === "user" && item.text === "one")).toBe(false);
  });

  test("orders normalized metadata by updated time and stable ID", () => {
    const store = createTuiAppStore([
      metadata("b", 2),
      metadata("c", 4),
      metadata("a", 2),
    ]);
    expect(selectOrderedSessions(store.getSnapshot()).map((item) => item.id)).toEqual(["c", "a", "b"]);
  });
});

function archive(
  sessionID: string,
  turns: SessionTurn[],
  events: SessionEventRecord[],
  draft?: { text: string; revision: number },
): ArchivedSession {
  return {
    metadata: { ...metadata(sessionID, 10), turnCount: turns.length },
    turns,
    events,
    history: [],
    draft: draft
      ? { sessionID, text: draft.text, revision: draft.revision, createdAt: 1 }
      : undefined,
  };
}

function metadata(id: string, updatedAt: number): SessionMetadata {
  return {
    id,
    title: id,
    workspace: "/workspace",
    model: { providerID: "test", modelID: "model" },
    mode: "build",
    createdAt: 1,
    updatedAt,
    turnCount: 0,
  };
}

function turn(
  sessionID: string,
  id: string,
  ordinal: number,
  boundarySeq: number,
  status: SessionTurn["status"],
  prompt: string,
): SessionTurn {
  return {
    id,
    sessionID,
    ordinal,
    prompt,
    status,
    acceptedAt: ordinal,
    settledAt: status === "running" ? undefined : ordinal + 1,
    boundarySeq,
    checkpoint: { history: [], data: null },
  };
}

function summary(
  sessionID: string,
  id: string,
  ordinal: number,
  boundarySeq: number,
  status: SessionTurn["status"],
  prompt: string,
) {
  const { checkpoint: _, ...result } = turn(sessionID, id, ordinal, boundarySeq, status, prompt);
  return result;
}

function record(
  sessionID: string,
  seq: number,
  turnID: string | undefined,
  event: SessionEvent,
): SessionEventRecord {
  return { sessionID, seq, at: seq, turnID, event };
}

function hostEvent(
  sessionID: string,
  seq: number,
  turnID: string,
  event: SessionEvent,
) {
  return {
    type: "session-event" as const,
    sessionID,
    turnID,
    event,
    record: record(sessionID, seq, turnID, event),
  };
}
