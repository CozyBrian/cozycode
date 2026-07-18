import { describe, expect, test } from "bun:test";
import {
  BunSQLiteSessionArchive,
  SessionArchiveError,
  type ModelHistory,
} from "../src/index.ts";

describe("fork and revert boundaries", () => {
  test("forks full and prefix conversations and reverts to an accepted-turn checkpoint", () => {
    const archive = BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
    archive.createSession({
      id: "source",
      title: "Source",
      workspace: "/project",
      model: { providerID: "test", modelID: "model" },
      mode: "build",
      effort: "high",
      createdAt: 1,
    });

    const history1: ModelHistory = [
      { role: "user", content: "one" },
      { role: "assistant", content: "answer one" },
    ];
    completeTurn(archive, "turn-1", "one", "answer one", 10, history1);

    archive.acceptTurn({
      sessionID: "source",
      turnID: "turn-2",
      prompt: "two",
      acceptedAt: 20,
      rollbackData: { draftRevision: 7 },
    });
    const boundary = archive.getRevertBoundary("source", "turn-2");
    expect(boundary).toMatchObject({
      turnOrdinal: 2,
      eventSeq: 3,
      previousTurnID: "turn-1",
      checkpoint: { history: history1, data: { draftRevision: 7 } },
    });
    const prefix = archive.forkFromTurn("source", "turn-2", {
      id: "prefix",
      createdAt: 21,
    });
    expect(prefix).toMatchObject({ title: "Source (fork)", turnCount: 1 });
    expect(archive.listEvents("prefix").map((event) => event.seq)).toEqual([1, 2]);
    expect(archive.listTurns("prefix")[0]?.id).not.toBe("turn-1");
    expect(archive.getModelHistory("prefix")).toEqual(history1);
    expect(archive.getDraft("prefix")).toBeUndefined();

    archive.appendEvent({
      sessionID: "source",
      turnID: "turn-2",
      at: 22,
      event: { type: "text-delta", text: "answer two" },
    });
    const history2: ModelHistory = [
      ...history1,
      { role: "user", content: "two" },
      { role: "assistant", content: "answer two" },
    ];
    archive.settleTurn({
      sessionID: "source",
      turnID: "turn-2",
      status: "completed",
      settledAt: 23,
      terminalEvent: { type: "finish", reason: "stop" },
      history: history2,
    });

    archive.acceptTurn({ sessionID: "source", turnID: "turn-3", prompt: "three", acceptedAt: 30 });
    expectArchiveError(() => archive.forkSession("source", { id: "unsafe", createdAt: 31 }), "BUSY");
    archive.appendEvent({
      sessionID: "source",
      turnID: "turn-3",
      at: 31,
      event: { type: "text-delta", text: "answer three" },
    });
    const history3: ModelHistory = [
      ...history2,
      { role: "user", content: "three" },
      { role: "assistant", content: "answer three" },
    ];
    archive.settleTurn({
      sessionID: "source",
      turnID: "turn-3",
      status: "completed",
      settledAt: 32,
      terminalEvent: { type: "finish", reason: "stop" },
      history: history3,
    });

    const full = archive.forkSession("source", { id: "full", createdAt: 40 });
    expect(full.turnCount).toBe(3);
    expect(archive.listEvents("full").map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(archive.listTurns("full").map((turn) => turn.id)).not.toContain("turn-1");
    expect(archive.getModelHistory("full")).toEqual(history3);

    const reverted = archive.revertToBoundary(boundary, 50);
    expect(reverted).toMatchObject({ turnCount: 1, updatedAt: 50 });
    expect(archive.listTurns("source").map((turn) => turn.id)).toEqual(["turn-1"]);
    expect(archive.listEvents("source").map((event) => event.seq)).toEqual([1, 2]);
    expect(archive.getModelHistory("source")).toEqual(history1);

    const replacement = archive.acceptTurn({
      sessionID: "source",
      turnID: "turn-replacement",
      prompt: "changed",
      acceptedAt: 51,
    });
    expect(replacement.boundarySeq).toBe(7);
    expect(archive.appendEvent({
      sessionID: "source",
      turnID: "turn-replacement",
      at: 52,
      event: { type: "text-delta", text: "new" },
    }).seq).toBe(7);
    archive.close();
  });
});

function completeTurn(
  archive: BunSQLiteSessionArchive,
  turnID: string,
  prompt: string,
  answer: string,
  at: number,
  history: ModelHistory,
): void {
  archive.acceptTurn({ sessionID: "source", turnID, prompt, acceptedAt: at });
  archive.appendEvent({
    sessionID: "source",
    turnID,
    at: at + 1,
    event: { type: "text-delta", text: answer },
  });
  archive.settleTurn({
    sessionID: "source",
    turnID,
    status: "completed",
    settledAt: at + 2,
    terminalEvent: { type: "finish", reason: "stop" },
    history,
  });
}

function expectArchiveError(run: () => unknown, code: SessionArchiveError["code"]): void {
  try {
    run();
    throw new Error(`Expected SessionArchiveError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SessionArchiveError);
    expect((error as SessionArchiveError).code).toBe(code);
  }
}
