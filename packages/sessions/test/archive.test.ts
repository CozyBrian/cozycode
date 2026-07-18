import { describe, expect, test } from "bun:test";
import {
  BunSQLiteSessionArchive,
  SessionArchiveError,
  type ModelHistory,
} from "../src/index.ts";

describe("BunSQLiteSessionArchive", () => {
  test("keeps in-memory archives independent", () => {
    const first = BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
    const second = BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
    first.createSession({
      id: "first",
      workspace: null,
      model: { providerID: "test", modelID: "model" },
      mode: "build",
      createdAt: 1,
    });
    second.createSession({
      id: "second",
      workspace: null,
      model: { providerID: "test", modelID: "model" },
      mode: "build",
      createdAt: 1,
    });
    expect(first.listSessions().map((session) => session.id)).toEqual(["first"]);
    expect(second.listSessions().map((session) => session.id)).toEqual(["second"]);
    first.close();
    second.close();
  });

  test("stores metadata, ordered turns/events, histories, and revisioned drafts", () => {
    const archive = BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false, now: () => 100 });
    const created = archive.createSession({
      id: "session",
      title: "TUI chat",
      workspace: "/workspace",
      model: { providerID: "test", modelID: "model-a" },
      mode: "build",
      effort: "medium",
      createdAt: 1,
    });
    expect(created).toEqual({
      id: "session",
      title: "TUI chat",
      workspace: "/workspace",
      model: { providerID: "test", modelID: "model-a" },
      mode: "build",
      effort: "medium",
      createdAt: 1,
      updatedAt: 1,
      turnCount: 0,
    });

    expect(archive.saveDraft({ sessionID: "session", text: "hel", createdAt: 2 })).toMatchObject({
      revision: 1,
      text: "hel",
    });
    expect(archive.saveDraft({
      sessionID: "session",
      text: "hello",
      createdAt: 3,
      expectedRevision: 1,
    })).toMatchObject({ revision: 2, text: "hello" });
    expectArchiveError(
      () => archive.saveDraft({ sessionID: "session", text: "stale", expectedRevision: 1 }),
      "REVISION_CONFLICT",
    );

    const turn = archive.acceptTurn({
      sessionID: "session",
      turnID: "turn-1",
      prompt: "hello",
      acceptedAt: 10,
      rollbackData: { draftRevision: 2 },
    });
    expect(turn).toMatchObject({
      id: "turn-1",
      ordinal: 1,
      status: "running",
      boundarySeq: 1,
      checkpoint: { history: [], data: { draftRevision: 2 } },
    });
    expect(archive.appendEvent({
      sessionID: "session",
      turnID: "turn-1",
      at: 11,
      event: { type: "text-delta", text: "hi" },
    }).seq).toBe(1);
    expect(archive.appendEvent({
      sessionID: "session",
      turnID: "turn-1",
      at: 12,
      event: { type: "tool-call-start", toolCallId: "call", toolName: "read", args: { path: "a.ts" } },
    }).seq).toBe(2);
    expectArchiveError(
      () => archive.appendEvent({
        sessionID: "session",
        turnID: "turn-1",
        at: 13,
        event: { type: "finish", reason: "stop" },
      }),
      "INVALID",
    );

    const history: ModelHistory = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const settled = archive.settleTurn({
      sessionID: "session",
      turnID: "turn-1",
      status: "completed",
      settledAt: 14,
      terminalEvent: { type: "finish", reason: "stop", usage: { totalTokens: 3 } },
      history,
    });
    expect(settled.event.seq).toBe(3);
    expect(settled.turn.status).toBe("completed");
    expect(archive.getModelHistory("session")).toEqual(history);
    expect(archive.listEvents("session", 1).map((record) => record.seq)).toEqual([2, 3]);

    const updated = archive.updateSession("session", {
      title: "Renamed",
      model: { providerID: "test", modelID: "model-b" },
      mode: "plan",
      effort: null,
    }, 20);
    expect(updated).toMatchObject({
      title: "Renamed",
      model: { providerID: "test", modelID: "model-b" },
      mode: "plan",
      updatedAt: 20,
      turnCount: 1,
    });
    expect(updated.effort).toBeUndefined();

    const loaded = archive.loadSession("session");
    expect(loaded?.turns).toHaveLength(1);
    expect(loaded?.events.map((record) => record.seq)).toEqual([1, 2, 3]);
    expect(loaded?.draft).toMatchObject({ revision: 2, text: "hello" });
    expect(archive.listDraftRevisions("session").map((draft) => draft.revision)).toEqual([1, 2]);

    expect(archive.deleteSession("session")).toBe(true);
    expect(archive.getSession("session")).toBeUndefined();
    expect(archive.deleteSession("session")).toBe(false);
    archive.close();
    archive.close();
    expectArchiveError(() => archive.listSessions(), "CLOSED");
  });

  test("loads bounded recent replay data without checkpoint or model history payloads", () => {
    const archive = BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
    archive.createSession({
      id: "recent",
      workspace: null,
      model: { providerID: "test", modelID: "model" },
      mode: "build",
      createdAt: 1,
    });
    const history: ModelHistory = [];
    for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
      const turnID = `turn-${ordinal}`;
      const acceptedAt = ordinal * 10;
      archive.acceptTurn({
        sessionID: "recent",
        turnID,
        prompt: `prompt ${ordinal}`,
        acceptedAt,
      });
      archive.appendEvent({
        sessionID: "recent",
        turnID,
        at: acceptedAt + 1,
        event: { type: "text-delta", text: `answer ${ordinal}` },
      });
      history.push(
        { role: "user", content: `prompt ${ordinal}` },
        { role: "assistant", content: `answer ${ordinal}` },
      );
      archive.settleTurn({
        sessionID: "recent",
        turnID,
        status: "completed",
        settledAt: acceptedAt + 2,
        terminalEvent: { type: "finish", reason: "stop" },
        history: structuredClone(history),
      });
    }

    const recent = archive.loadRecentSession("recent", { eventLimit: 10, turnLimit: 2 })!;
    expect(recent.turns.map((turn) => turn.id)).toEqual(["turn-3", "turn-4"]);
    expect(recent.events.map((event) => event.seq)).toEqual([5, 6, 7, 8]);
    expect(recent.window).toEqual({
      eventsOmitted: true,
      turnsOmitted: true,
      firstEventSeq: 5,
      lastEventSeq: 8,
    });
    expect("checkpoint" in recent.turns[0]!).toBe(false);
    expect("history" in recent).toBe(false);
    expect(archive.getModelHistory("recent")).toEqual(history);
    expect(archive.loadSession("recent")?.events).toHaveLength(8);

    const eventBounded = archive.loadRecentSession("recent", { eventLimit: 3, turnLimit: 4 })!;
    expect(eventBounded.events.map((event) => event.seq)).toEqual([6, 7, 8]);
    expect(eventBounded.window.eventsOmitted).toBe(true);
    expect(eventBounded.window.turnsOmitted).toBe(false);
    archive.close();
  });

  test("keeps terminal status, event, and model history atomic", () => {
    const archive = BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
    archive.createSession({
      id: "atomic",
      workspace: null,
      model: { providerID: "test", modelID: "model" },
      mode: "build",
      createdAt: 1,
    });
    archive.acceptTurn({ sessionID: "atomic", turnID: "turn", prompt: "go", acceptedAt: 2 });

    expectArchiveError(() => archive.settleTurn({
      sessionID: "atomic",
      turnID: "turn",
      status: "failed",
      settledAt: 3,
      terminalEvent: { type: "finish", reason: "stop" },
      history: [{ role: "user", content: "go" }],
    }), "INVALID");
    expect(archive.listTurns("atomic")[0]?.status).toBe("running");
    expect(archive.listEvents("atomic")).toEqual([]);
    expect(archive.getModelHistory("atomic")).toEqual([]);

    archive.settleTurn({
      sessionID: "atomic",
      turnID: "turn",
      status: "failed",
      settledAt: 4,
      terminalEvent: { type: "error", message: "provider failed" },
      history: [{ role: "user", content: "go" }],
    });
    expect(archive.listTurns("atomic")[0]).toMatchObject({
      status: "failed",
      errorMessage: "provider failed",
    });
    archive.close();
  });

  test("rejects non-JSON event payloads before writing", () => {
    const archive = BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
    archive.createSession({
      id: "json",
      workspace: null,
      model: { providerID: "test", modelID: "model" },
      mode: "build",
      createdAt: 1,
    });
    archive.acceptTurn({ sessionID: "json", turnID: "turn", prompt: "go", acceptedAt: 2 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectArchiveError(() => archive.appendEvent({
      sessionID: "json",
      turnID: "turn",
      at: 3,
      event: {
        type: "tool-result",
        toolCallId: "call",
        toolName: "tool",
        result: cyclic,
        isError: false,
      },
    }), "INVALID");
    expect(archive.listEvents("json")).toEqual([]);
    archive.close();
  });
});

function expectArchiveError(run: () => unknown, code: SessionArchiveError["code"]): void {
  try {
    run();
    throw new Error(`Expected SessionArchiveError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SessionArchiveError);
    expect((error as SessionArchiveError).code).toBe(code);
  }
}
