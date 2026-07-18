import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  BunSQLiteSessionArchive,
  SESSION_SCHEMA_VERSION,
  SessionArchiveError,
  createTemporarySessionArchive,
} from "../src/index.ts";

describe("recovery and schema management", () => {
  test("exclusively leases a live file-backed archive before recovery", () => {
    const temporary = createTemporarySessionArchive({ recoverInterrupted: false, now: () => 50 });
    temporary.archive.createSession({
      id: "leased",
      workspace: "/workspace",
      model: { providerID: "test", modelID: "model" },
      mode: "build",
      createdAt: 1,
    });
    temporary.archive.acceptTurn({
      sessionID: "leased",
      turnID: "live-turn",
      prompt: "still working",
      acceptedAt: 10,
    });

    expectArchiveError(() => {
      const second = new BunSQLiteSessionArchive({ filename: temporary.filename, now: () => 100 });
      second.close();
    }, "BUSY");
    expect(temporary.archive.listTurns("leased")[0]?.status).toBe("running");
    expect(temporary.archive.appendEvent({
      sessionID: "leased",
      turnID: "live-turn",
      at: 11,
      event: { type: "text-delta", text: "still alive" },
    }).seq).toBe(1);
    temporary.archive.settleTurn({
      sessionID: "leased",
      turnID: "live-turn",
      status: "completed",
      settledAt: 12,
      terminalEvent: { type: "finish", reason: "stop" },
      history: [
        { role: "user", content: "still working" },
        { role: "assistant", content: "still alive" },
      ],
    });

    temporary.archive.close();
    temporary.archive.close();
    const reopened = new BunSQLiteSessionArchive({
      filename: temporary.filename,
      recoverInterrupted: false,
    });
    expect(reopened.listTurns("leased")[0]?.status).toBe("completed");
    reopened.close();
    temporary.cleanup();
  });

  test("recovers a running turn on reopen and continues with a stable sequence", () => {
    const temporary = createTemporarySessionArchive({ recoverInterrupted: false, now: () => 50 });
    temporary.archive.createSession({
      id: "recover",
      workspace: "/workspace",
      model: { providerID: "test", modelID: "model" },
      mode: "build",
      createdAt: 1,
    });
    temporary.archive.acceptTurn({
      sessionID: "recover",
      turnID: "turn-1",
      prompt: "first",
      acceptedAt: 10,
    });
    temporary.archive.appendEvent({
      sessionID: "recover",
      turnID: "turn-1",
      at: 11,
      event: { type: "text-delta", text: "partial" },
    });
    temporary.archive.saveDraft({ sessionID: "recover", text: "next", createdAt: 12 });
    temporary.archive.flush();
    temporary.archive.close();

    const reopened = new BunSQLiteSessionArchive({ filename: temporary.filename, now: () => 100 });
    expect(reopened.listTurns("recover")[0]).toMatchObject({
      status: "interrupted",
      settledAt: 100,
      finishReason: "interrupted",
    });
    expect(reopened.listEvents("recover").map((record) => [record.seq, record.event.type])).toEqual([
      [1, "text-delta"],
      [2, "finish"],
    ]);
    expect(reopened.getModelHistory("recover")).toEqual([]);
    expect(reopened.getDraft("recover")?.text).toBe("next");

    const second = reopened.acceptTurn({
      sessionID: "recover",
      turnID: "turn-2",
      prompt: "second",
      acceptedAt: 110,
    });
    expect(second.boundarySeq).toBe(3);
    expect(reopened.appendEvent({
      sessionID: "recover",
      turnID: "turn-2",
      at: 111,
      event: { type: "text-delta", text: "answer" },
    }).seq).toBe(3);
    reopened.close();
    temporary.cleanup();
  });

  test("uses WAL, migrates each user_version, and rejects newer schemas", () => {
    const temporary = createTemporarySessionArchive({ recoverInterrupted: false });
    temporary.archive.close();

    const raw = new Database(temporary.filename);
    expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(SESSION_SCHEMA_VERSION);
    expect(raw.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    const strictTables = raw.query<{ name: string; strict: number }, []>(`
      SELECT name, strict FROM pragma_table_list
      WHERE name IN ('sessions', 'turns', 'events', 'model_histories', 'drafts', 'session_reverts')
    `).all();
    expect(strictTables).toHaveLength(6);
    expect(strictTables.every((table) => table.strict === 1)).toBe(true);

    raw.exec("DROP TABLE session_reverts");
    raw.exec("DROP TABLE drafts");
    raw.exec("PRAGMA user_version = 1");
    raw.close();
    const migrated = new BunSQLiteSessionArchive({ filename: temporary.filename, recoverInterrupted: false });
    migrated.createSession({
      id: "migrated",
      workspace: null,
      model: { providerID: "test", modelID: "model" },
      mode: "build",
      createdAt: 1,
    });
    expect(migrated.saveDraft({ sessionID: "migrated", text: "works", createdAt: 2 }).revision).toBe(1);
    migrated.close();

    const newer = new Database(temporary.filename);
    newer.exec(`PRAGMA user_version = ${SESSION_SCHEMA_VERSION + 1}`);
    newer.close();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expectArchiveError(
        () => new BunSQLiteSessionArchive({ filename: temporary.filename }),
        "UNSUPPORTED_SCHEMA",
      );
    }
    temporary.cleanup();
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
