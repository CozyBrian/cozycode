import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  BunSQLiteSessionArchive,
  SessionArchiveError,
  createTemporarySessionArchive,
  type ModelHistory,
} from "../src/index.ts";

describe("persistent linear undo and redo", () => {
  test("moves a non-destructive cursor through multiple turns and filters visible replay", () => {
    const archive = BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
    const histories = createThreeTurnSession(archive, "linear");

    const first = archive.undoToTurn("linear", "linear-turn-3", {
      updatedAt: 40,
      expectedRevision: 0,
    });
    expect(first).toMatchObject({
      revision: 1,
      boundaryTurnID: "linear-turn-3",
      boundaryOrdinal: 3,
      boundarySeq: 5,
      visibleTurnCount: 2,
      originalTurnCount: 3,
      originalHistory: histories[2],
      rollbackData: { beforeTurn: 3 },
    });
    expect(archive.getSession("linear")?.turnCount).toBe(2);
    expect(archive.listTurns("linear").map((turn) => turn.id)).toEqual([
      "linear-turn-1",
      "linear-turn-2",
    ]);
    expect(archive.listEvents("linear").map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(archive.listVisibleEvents("linear").map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(archive.getModelHistory("linear")).toEqual(histories[1]);

    const second = archive.undoToTurn("linear", "linear-turn-2", {
      updatedAt: 41,
      expectedRevision: 1,
    });
    expect(second).toMatchObject({
      revision: 2,
      boundaryTurnID: "linear-turn-2",
      visibleTurnCount: 1,
      originalTurnCount: 3,
      rollbackData: { beforeTurn: 2 },
    });
    expect(archive.listVisibleEvents("linear", 1).map((event) => event.seq)).toEqual([2]);
    expect(archive.getModelHistory("linear")).toEqual(histories[0]);

    const redone = archive.redoTurn("linear", { updatedAt: 42, expectedRevision: 2 });
    expect(redone).toMatchObject({
      revision: 3,
      boundaryTurnID: "linear-turn-3",
      visibleTurnCount: 2,
      rollbackData: { beforeTurn: 3 },
    });
    expect(archive.getModelHistory("linear")).toEqual(histories[1]);
    expect(archive.listVisibleEvents("linear").map((event) => event.seq)).toEqual([1, 2, 3, 4]);

    expect(archive.redoTurn("linear", { updatedAt: 43, expectedRevision: 3 })).toBeUndefined();
    expect(archive.getRevertState("linear")).toBeUndefined();
    expect(archive.getSession("linear")?.turnCount).toBe(3);
    expect(archive.getModelHistory("linear")).toEqual(histories[2]);
    expect(archive.listVisibleEvents("linear")).toEqual(archive.listEvents("linear"));
    archive.close();
  });

  test("persists cursor state across restart and forks only the visible prefix", () => {
    const temporary = createTemporarySessionArchive({ recoverInterrupted: false });
    const histories = createThreeTurnSession(temporary.archive, "persist");
    temporary.archive.undoToTurn("persist", "persist-turn-2", { updatedAt: 40 });
    temporary.archive.close();

    const reopened = new BunSQLiteSessionArchive({
      filename: temporary.filename,
      recoverInterrupted: false,
    });
    expect(reopened.getRevertState("persist")).toMatchObject({
      revision: 1,
      boundaryTurnID: "persist-turn-2",
      visibleTurnCount: 1,
      originalTurnCount: 3,
    });
    expect(reopened.getModelHistory("persist")).toEqual(histories[0]);
    expect(reopened.listEvents("persist")).toHaveLength(6);
    expect(reopened.listVisibleEvents("persist")).toHaveLength(2);

    const fork = reopened.forkSession("persist", { id: "visible-fork", createdAt: 50 });
    expect(fork.turnCount).toBe(1);
    expect(reopened.listTurns("visible-fork")).toHaveLength(1);
    expect(reopened.listEvents("visible-fork").map((event) => event.seq)).toEqual([1, 2]);
    expect(reopened.getModelHistory("visible-fork")).toEqual(histories[0]);
    expect(reopened.getRevertState("visible-fork")).toBeUndefined();
    expectArchiveError(
      () => reopened.forkFromTurn("persist", "persist-turn-2", { id: "hidden-fork", createdAt: 51 }),
      "REVISION_CONFLICT",
    );

    expect(reopened.deleteSession("persist")).toBe(true);
    const raw = new Database(temporary.filename, { readonly: true });
    expect(raw.query<{ count: number }, []>("SELECT count(*) AS count FROM session_reverts").get()?.count).toBe(0);
    raw.close();
    reopened.close();
    temporary.cleanup();
  });

  test("commits the hidden suffix before accepting a replacement branch", () => {
    const archive = BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
    createThreeTurnSession(archive, "branch");
    const state = archive.undoToTurn("branch", "branch-turn-2", { updatedAt: 40 });

    expectArchiveError(
      () => archive.acceptTurn({
        sessionID: "branch",
        turnID: "blocked",
        prompt: "must commit first",
        acceptedAt: 41,
      }),
      "REVISION_CONFLICT",
    );
    const committed = archive.commitRevert("branch", {
      updatedAt: 42,
      expectedRevision: state.revision,
    });
    expect(committed.turnCount).toBe(1);
    expect(archive.getRevertState("branch")).toBeUndefined();
    expect(archive.listTurns("branch").map((turn) => turn.id)).toEqual(["branch-turn-1"]);
    expect(archive.listEvents("branch").map((event) => event.seq)).toEqual([1, 2]);

    const replacement = archive.acceptTurn({
      sessionID: "branch",
      turnID: "replacement",
      prompt: "new branch",
      acceptedAt: 43,
    });
    expect(replacement.ordinal).toBe(2);
    expect(replacement.boundarySeq).toBe(7);
    expect(archive.appendEvent({
      sessionID: "branch",
      turnID: "replacement",
      at: 44,
      event: { type: "text-delta", text: "new answer" },
    }).seq).toBe(7);
    archive.close();
  });

  test("rejects running turns, stale revisions, and invalid cursor moves", () => {
    const running = BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
    const histories = createTwoTurnSession(running, "running");
    running.acceptTurn({
      sessionID: "running",
      turnID: "running-turn-3",
      prompt: "still running",
      acceptedAt: 30,
    });
    expectArchiveError(
      () => running.undoToTurn("running", "running-turn-2", { updatedAt: 31 }),
      "BUSY",
    );
    running.settleTurn({
      sessionID: "running",
      turnID: "running-turn-3",
      status: "completed",
      settledAt: 32,
      terminalEvent: { type: "finish", reason: "stop" },
      history: [
        ...histories[1],
        { role: "user", content: "still running" },
        { role: "assistant", content: "done" },
      ],
    });

    const state = running.undoToTurn("running", "running-turn-2", { updatedAt: 40 });
    expectArchiveError(
      () => running.undoToTurn("running", "running-turn-2", { updatedAt: 41 }),
      "REVISION_CONFLICT",
    );
    expectArchiveError(
      () => running.undoToTurn("running", "running-turn-3", { updatedAt: 41 }),
      "REVISION_CONFLICT",
    );
    expectArchiveError(
      () => running.redoTurn("running", { updatedAt: 41, expectedRevision: state.revision - 1 }),
      "REVISION_CONFLICT",
    );
    expectArchiveError(
      () => running.commitRevert("running", { updatedAt: 41, expectedRevision: state.revision + 1 }),
      "REVISION_CONFLICT",
    );
    expect(running.getRevertState("running")?.revision).toBe(state.revision);
    running.close();
  });
});

function createThreeTurnSession(
  archive: BunSQLiteSessionArchive,
  sessionID: string,
): [ModelHistory, ModelHistory, ModelHistory] {
  archive.createSession({
    id: sessionID,
    title: sessionID,
    workspace: "/workspace",
    model: { providerID: "test", modelID: "model" },
    mode: "build",
    createdAt: 1,
  });
  const histories: ModelHistory[] = [];
  let history: ModelHistory = [];
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const prompt = `turn ${ordinal}`;
    const answer = `answer ${ordinal}`;
    history = [
      ...history,
      { role: "user", content: prompt },
      { role: "assistant", content: answer },
    ];
    completeTurn(archive, sessionID, ordinal, prompt, answer, history);
    histories.push(history);
  }
  return [histories[0]!, histories[1]!, histories[2]!];
}

function createTwoTurnSession(
  archive: BunSQLiteSessionArchive,
  sessionID: string,
): [ModelHistory, ModelHistory] {
  archive.createSession({
    id: sessionID,
    title: sessionID,
    workspace: null,
    model: { providerID: "test", modelID: "model" },
    mode: "build",
    createdAt: 1,
  });
  const history1: ModelHistory = [
    { role: "user", content: "turn 1" },
    { role: "assistant", content: "answer 1" },
  ];
  completeTurn(archive, sessionID, 1, "turn 1", "answer 1", history1);
  const history2: ModelHistory = [
    ...history1,
    { role: "user", content: "turn 2" },
    { role: "assistant", content: "answer 2" },
  ];
  completeTurn(archive, sessionID, 2, "turn 2", "answer 2", history2);
  return [history1, history2];
}

function completeTurn(
  archive: BunSQLiteSessionArchive,
  sessionID: string,
  ordinal: number,
  prompt: string,
  answer: string,
  history: ModelHistory,
): void {
  const acceptedAt = ordinal * 10;
  const turnID = `${sessionID}-turn-${ordinal}`;
  archive.acceptTurn({
    sessionID,
    turnID,
    prompt,
    acceptedAt,
    rollbackData: { beforeTurn: ordinal },
  });
  archive.appendEvent({
    sessionID,
    turnID,
    at: acceptedAt + 1,
    event: { type: "text-delta", text: answer },
  });
  archive.settleTurn({
    sessionID,
    turnID,
    status: "completed",
    settledAt: acceptedAt + 2,
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
