import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../src/main/session-store.ts";

const dirs = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "cozycode-session-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SQLite SessionStore", () => {
  test("persists ordered sessions, replay records, history, and cascading deletion", async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    const first = await store.create({
      id: "first",
      workspaceRoot: "/one",
      model: { providerID: "test", modelID: "model" },
      preset: "ask",
      now: 1,
    });
    await store.create({
      id: "second",
      workspaceRoot: null,
      model: { providerID: "test", modelID: "model" },
      preset: "plan",
      now: 2,
    });
    store.appendUser(first.id, "hello");
    store.appendEvent(first.id, { type: "text-delta", text: "hel" });
    store.appendEvent(first.id, { type: "text-delta", text: "lo" });
    store.appendEvent(first.id, { type: "finish", reason: "stop" });
    await store.writeHistory(first.id, [{ role: "user", content: "hello" }]);

    assert.deepEqual((await store.list()).map((session) => session.id), ["second", "first"]);
    const records = await store.readRecords(first.id);
    assert.deepEqual(records, [
      { at: records[0].at, kind: "user", text: "hello", turnId: records[0].turnId },
      { at: records[1].at, kind: "event", event: { type: "text-delta", text: "hello" } },
      { at: records[2].at, kind: "event", event: { type: "finish", reason: "stop" } },
    ]);
    assert.deepEqual(await store.readHistory(first.id), [{ role: "user", content: "hello" }]);

    await store.remove(first.id);
    assert.equal(await store.get(first.id), undefined);
    assert.deepEqual(await store.readRecords(first.id), []);
    assert.equal(await store.readHistory(first.id), undefined);
    await store.dispose();
  });

  test("imports legacy files once in a restart-safe transaction", async () => {
    const dir = tempDir();
    const meta = {
      id: "legacy",
      title: "Legacy chat",
      titleEdited: true,
      createdAt: 10,
      updatedAt: 20,
      workspaceRoot: "/legacy",
      model: "old-model",
      preset: "ask",
      messageCount: 1,
    };
    writeFileSync(join(dir, "index.json"), JSON.stringify({ version: 1, sessions: [meta] }));
    writeFileSync(join(dir, "legacy.events.jsonl"), [
      JSON.stringify({ at: 11, kind: "user", text: "migrated" }),
      JSON.stringify({ at: 12, kind: "event", event: { type: "finish", reason: "stop" } }),
      "{torn",
      "",
    ].join("\n"));
    const history = [
      { role: "user", content: "migrated" },
      { role: "assistant", content: [
        { type: "custom", kind: "provider-part" },
        { type: "tool-approval-request", approvalId: "approval", toolCallId: "call" },
      ] },
      { role: "tool", content: [{ type: "tool-approval-response", approvalId: "approval", approved: true }] },
    ];
    writeFileSync(join(dir, "legacy.history.json"), JSON.stringify(history));

    const first = new SessionStore(dir, "legacy-provider");
    assert.deepEqual((await first.get("legacy")).model, {
      providerID: "legacy-provider",
      modelID: "old-model",
    });
    assert.equal((await first.readRecords("legacy")).length, 2);
    assert.deepEqual(await first.readHistory("legacy"), history);
    await first.dispose();

    writeFileSync(join(dir, "legacy.events.jsonl"), `${JSON.stringify({ at: 13, kind: "user", text: "do not reimport" })}\n`, { flag: "a" });
    const reopened = new SessionStore(dir, "legacy-provider");
    assert.equal((await reopened.readRecords("legacy")).length, 2);
    await reopened.dispose();
  });

  test("backfills stable turn ids when opening a version-one database", async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, "sessions.sqlite"));
    db.exec(`
      CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, title_edited INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, workspace_root TEXT,
        provider_id TEXT NOT NULL, model_id TEXT NOT NULL, preset TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0, parent_id TEXT, agent TEXT
      ) STRICT;
      CREATE TABLE records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'event')),
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE histories (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        messages_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO sessions VALUES ('old', 'Old', 0, 1, 1, NULL, 'test', 'model', 'ask', 1, NULL, NULL);
      INSERT INTO records (session_id, at, kind, payload_json) VALUES ('old', 1, 'user', '"hello"');
      INSERT INTO records (session_id, at, kind, payload_json) VALUES ('old', 2, 'event', '{"type":"finish","reason":"stop"}');
      PRAGMA user_version = 1;
    `);
    db.close();

    const store = new SessionStore(dir);
    const user = (await store.readRecords("old"))[0];
    assert.equal(user.kind, "user");
    assert.equal(typeof user.turnId, "string");
    assert.ok(user.turnId.length > 0);
    await store.dispose();
  });

  test("allows a WAL reader while another store writes", async () => {
    const dir = tempDir();
    const writer = new SessionStore(dir);
    await writer.create({
      id: "shared",
      workspaceRoot: null,
      model: { providerID: "test", modelID: "model" },
      preset: "ask",
      now: 1,
    });
    const reader = new SessionStore(dir);

    writer.appendUser("shared", "live");
    writer.appendEvent("shared", { type: "finish", reason: "stop" });

    assert.equal((await reader.readRecords("shared")).length, 2);
    await Promise.all([writer.dispose(), reader.dispose()]);
  });

  test("applies disjoint metadata patches without reverting either one", async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    await store.create({
      id: "patches",
      workspaceRoot: null,
      model: { providerID: "test", modelID: "old" },
      preset: "ask",
      now: 1,
    });

    await Promise.all([
      store.touch("patches", { model: { providerID: "test", modelID: "new" } }),
      store.touch("patches", { messageCount: 3, updatedAt: 4 }),
    ]);

    assert.deepEqual(await store.get("patches"), {
      id: "patches",
      title: "New session - 1970-01-01T00:00:00.001Z",
      titleEdited: false,
      createdAt: 1,
      updatedAt: 4,
      workspaceRoot: null,
      model: { providerID: "test", modelID: "new" },
      preset: "ask",
      messageCount: 3,
      parentID: null,
      agent: undefined,
    });
    await store.dispose();
  });

  test("atomically appends accepted user turns and updates counters", async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    await store.create({
      id: "turn",
      workspaceRoot: null,
      model: { providerID: "test", modelID: "model" },
      preset: "ask",
      now: 1,
    });

    assert.equal(store.appendUserTurn("turn", "one", 10), 1);
    assert.equal(store.appendUserTurn("turn", "two", 20), 2);
    assert.equal((await store.get("turn")).messageCount, 2);
    assert.equal((await store.get("turn")).updatedAt, 20);
    assert.deepEqual((await store.readRecords("turn")).filter((record) => record.kind === "user").map((record) => record.text), ["one", "two"]);
    await store.dispose();
  });

  test("forks complete and prefix histories and rewrites a selected turn", async () => {
    const dir = tempDir();
    const store = new SessionStore(dir);
    await store.create({
      id: "source",
      workspaceRoot: "/project",
      model: { providerID: "test", modelID: "model" },
      preset: "ask",
      now: 1,
      title: "Source",
    });
    store.appendUserTurn("source", "one", 10, "turn-one");
    store.appendEvent("source", { type: "text-delta", text: "answer one" });
    store.appendEvent("source", { type: "finish", reason: "stop" });
    store.appendUserTurn("source", "two", 20, "turn-two");
    store.appendEvent("source", { type: "text-delta", text: "answer two" });
    store.appendEvent("source", { type: "finish", reason: "stop" });
    const history = [
      { role: "user", content: "one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "two" },
      { role: "assistant", content: "answer two" },
    ];
    await store.writeHistory("source", history);

    const full = await store.forkSession("source", 30);
    assert.equal(full.title, "Source (fork)");
    assert.equal(full.messageCount, 2);
    assert.deepEqual(await store.readHistory(full.id), history);
    assert.notEqual((await store.readRecords(full.id))[0].turnId, "turn-one");

    const prefix = await store.forkFromTurn("source", "turn-two", 40);
    assert.equal(prefix.messageCount, 1);
    assert.deepEqual(await store.readHistory(prefix.id), history.slice(0, 2));
    assert.deepEqual(
      (await store.readRecords(prefix.id)).filter((record) => record.kind === "user").map((record) => record.text),
      ["one"],
    );

    const rewritten = await store.rewriteTurn("source", "turn-two", "turn-replacement", "changed", 50);
    assert.equal(rewritten.messageCount, 2);
    assert.deepEqual(await store.readHistory("source"), history.slice(0, 2));
    const users = (await store.readRecords("source")).filter((record) => record.kind === "user");
    assert.deepEqual(users.map((record) => record.text), ["one", "changed"]);
    assert.equal(users[1].turnId, "turn-replacement");
    assert.equal((await store.readRecords("source", false)).at(-1).kind, "user");
    await store.dispose();
  });

  test("opens with a malformed index and retries import after it is repaired", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "index.json"), "{broken");
    const first = new SessionStore(dir);
    assert.deepEqual(await first.list(), []);
    await first.dispose();

    const meta = {
      id: "repaired",
      title: "Recovered",
      titleEdited: false,
      createdAt: 1,
      updatedAt: 1,
      workspaceRoot: null,
      model: { providerID: "test", modelID: "model" },
      preset: "ask",
      messageCount: 0,
    };
    writeFileSync(join(dir, "index.json"), JSON.stringify({ version: 1, sessions: [meta] }));
    writeFileSync(join(dir, "repaired.history.json"), "not-json");
    const repaired = new SessionStore(dir);
    assert.equal((await repaired.get("repaired")).title, "Recovered");
    assert.equal(await repaired.readHistory("repaired"), undefined);
    await repaired.dispose();
  });

  test("flushes streaming text on a bounded timer", async () => {
    const dir = tempDir();
    const writer = new SessionStore(dir);
    await writer.create({
      id: "stream",
      workspaceRoot: null,
      model: { providerID: "test", modelID: "model" },
      preset: "ask",
      now: 1,
    });
    const reader = new SessionStore(dir);
    writer.appendEvent("stream", { type: "text-delta", text: "durable" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await reader.readRecords("stream"))[0].event.text, "durable");
    await Promise.all([writer.dispose(), reader.dispose()]);
  });

  test("retries a legacy replay log that was temporarily unreadable", async () => {
    const dir = tempDir();
    const meta = {
      id: "retry",
      title: "Retry",
      titleEdited: false,
      createdAt: 1,
      updatedAt: 1,
      workspaceRoot: null,
      model: { providerID: "test", modelID: "model" },
      preset: "ask",
      messageCount: 1,
    };
    writeFileSync(join(dir, "index.json"), JSON.stringify({ version: 1, sessions: [meta] }));
    const replayPath = join(dir, "retry.events.jsonl");
    mkdirSync(replayPath);

    const first = new SessionStore(dir);
    assert.deepEqual(await first.readRecords("retry"), []);
    await first.dispose();

    rmSync(replayPath, { recursive: true });
    writeFileSync(replayPath, [
      JSON.stringify({ at: 2, kind: "user", text: "recovered" }),
      JSON.stringify({ at: 3, kind: "event", event: { type: "finish", reason: "stop" } }),
      "",
    ].join("\n"));
    const retried = new SessionStore(dir);
    assert.equal((await retried.readRecords("retry")).length, 2);
    await retried.dispose();
  });
});
