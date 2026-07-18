import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncEventQueue, type ModelMessage } from "@cozycode/core";
import type {
  AgentMode,
  PermissionReply,
  PermissionRequest,
  QuestionRequest,
  SessionEvent,
} from "@cozycode/protocol";
import {
  BunSQLiteSessionArchive,
  createTemporarySessionArchive,
  type SessionArchive,
} from "@cozycode/sessions";
import {
  TuiSessionHost,
  type TuiRuntimeFactoryContext,
  type TuiSessionHostEvent,
  type TuiSessionLike,
} from "../src/runtime/index.ts";

const unsupportedSnapshots = async () => ({
  status: "unsupported" as const,
  reason: "not-git-workspace" as const,
});

describe("TuiSessionHost concurrency and durability", () => {
  test("fans interleaved events out with their owning session address", async () => {
    const archive = memoryArchive();
    const controls = new Map<string, Deferred<void>>();
    const runtimes = new Map<string, FakeSession>();
    const host = new TuiSessionHost({
      archive,
      deltaCoalesceIntervalMs: 5,
      runtimeFactory: (context) => {
        const control = deferred<void>();
        controls.set(context.metadata.id, control);
        const runtime = new FakeSession(context, async (session) => {
          await control.promise;
          session.finish("done");
        });
        runtimes.set(runtime.id, runtime);
        return runtime;
      },
    });
    create(host, "one", "plan");
    create(host, "two", "plan");

    const published: TuiSessionHostEvent[] = [];
    host.subscribe((event) => published.push(event));
    const first = host.send("one", "first", { turnID: "turn-one" });
    const second = host.send("two", "second", { turnID: "turn-two" });
    await waitFor(() => runtimes.size === 2);

    runtimes.get("one")!.emit({ type: "text-delta", text: "A" });
    runtimes.get("two")!.emit({ type: "text-delta", text: "B" });
    runtimes.get("one")!.emit({ type: "text-delta", text: "C" });
    await waitFor(() => sessionEvents(published, "text-delta").length === 2);
    controls.get("one")!.resolve();
    controls.get("two")!.resolve();
    await Promise.all([first, second]);

    expect(sessionEvents(published, "text-delta").map((event) => [event.sessionID, event.event.text])).toEqual([
      ["one", "AC"],
      ["two", "B"],
    ]);
    expect(archive.listEvents("one").map((record) => record.event.type)).toEqual([
      "text-delta",
      "finish",
    ]);
    expect(archive.listEvents("two").map((record) => record.event.type)).toEqual([
      "text-delta",
      "finish",
    ]);
    await host.close();
  });

  test("serializes build turns for one canonical workspace", async () => {
    const archive = memoryArchive();
    const started: string[] = [];
    const controls = new Map<string, Deferred<void>>();
    const host = new TuiSessionHost({
      archive,
      openSnapshotEngine: unsupportedSnapshots,
      runtimeFactory: (context) => new FakeSession(context, async (session) => {
        started.push(session.id);
        const control = deferred<void>();
        controls.set(session.id, control);
        await control.promise;
        session.finish("done");
      }),
    });
    create(host, "one", "build", "/same/workspace");
    create(host, "two", "build", "/same/workspace");

    const first = host.send("one", "first");
    const second = host.send("two", "second");
    await waitFor(() => started.length === 1);
    await tick();
    const firstStarted = started[0]!;
    expect(new Set(started)).toEqual(new Set([firstStarted]));
    controls.get(firstStarted)!.resolve();
    await waitFor(() => started.length === 2);
    expect(new Set(started)).toEqual(new Set(["one", "two"]));
    controls.get(started[1]!)!.resolve();
    await Promise.all([first, second]);
    await host.close();
  });

  test("allows plan turns in one workspace to run concurrently", async () => {
    const archive = memoryArchive();
    const started = new Set<string>();
    const release = deferred<void>();
    const host = new TuiSessionHost({
      archive,
      runtimeFactory: (context) => new FakeSession(context, async (session) => {
        started.add(session.id);
        await release.promise;
        session.finish("done");
      }),
    });
    create(host, "one", "plan", "/same/workspace");
    create(host, "two", "plan", "/same/workspace");

    const first = host.send("one", "first");
    const second = host.send("two", "second");
    await waitFor(() => started.size === 2);
    release.resolve();
    await Promise.all([first, second]);
    await host.close();
  });

  test("latches abort while a build turn waits for its workspace", async () => {
    const archive = memoryArchive();
    const controls = new Map<string, Deferred<void>>();
    const created: string[] = [];
    const statuses: string[] = [];
    const host = new TuiSessionHost({
      archive,
      openSnapshotEngine: unsupportedSnapshots,
      runtimeFactory: (context) => {
        created.push(context.metadata.id);
        return new FakeSession(context, async (session) => {
          const control = deferred<void>();
          controls.set(session.id, control);
          await control.promise;
          session.finish("done");
        });
      },
    });
    create(host, "one", "build", "/same/workspace");
    create(host, "two", "build", "/same/workspace");
    host.subscribe((event) => {
      if (event.type === "status" && event.sessionID === "two") statuses.push(event.status);
    });

    const first = host.send("one", "first");
    await waitFor(() => controls.has("one"));
    const second = host.send("two", "second");
    expect(host.abort("two")).toBe(true);
    controls.get("one")!.resolve();
    const [, aborted] = await Promise.all([first, second]);

    expect(created).toEqual(["one"]);
    expect(aborted.status).toBe("aborted");
    expect(statuses).toEqual(["queued", "settling", "idle"]);
    await host.close();
  });

  test("latches abort while the runtime factory is still resolving", async () => {
    const archive = memoryArchive();
    const creationStarted = deferred<void>();
    const releaseCreation = deferred<void>();
    let runtime: FakeSession | undefined;
    let sends = 0;
    let factorySignal: AbortSignal | undefined;
    const host = new TuiSessionHost({
      archive,
      runtimeFactory: async (context) => {
        factorySignal = context.signal;
        creationStarted.resolve();
        await releaseCreation.promise;
        runtime = new FakeSession(context, async (session) => {
          sends += 1;
          session.finish("should not run");
        });
        return runtime;
      },
    });
    create(host, "session", "plan");

    const turn = host.send("session", "stop during creation");
    await creationStarted.promise;
    expect(host.abort("session")).toBe(true);
    expect(factorySignal?.aborted).toBe(true);
    releaseCreation.resolve();
    const settled = await turn;

    expect(settled.status).toBe("aborted");
    expect(sends).toBe(0);
    expect(runtime?.abortCount).toBe(1);
    await host.close();
  });

  test("persists every event before fanout and settles history before the terminal event", async () => {
    const archive = memoryArchive();
    const observations: Array<{ type: string; durable: boolean }> = [];
    let eventsAtHistorySnapshot: string[] = [];
    const host = new TuiSessionHost({
      archive,
      runtimeFactory: (context) => {
        const runtime = new FakeSession(context, async (session) => {
          session.emit({ type: "text-delta", text: "one" });
          session.emit({ type: "text-delta", text: "two" });
          session.emit({ type: "text-delta", text: "three" });
          session.finish("answer");
        });
        runtime.onHistorySnapshot = () => {
          eventsAtHistorySnapshot = archive.listEvents("session").map((record) => record.event.type);
        };
        return runtime;
      },
    });
    create(host, "session", "plan");
    host.subscribe((event) => {
      if (event.type !== "session-event") return;
      const loaded = archive.loadSession("session")!;
      const terminal = event.event.type === "finish" || event.event.type === "error";
      observations.push({
        type: event.event.type,
        durable: loaded.events.some((record) => record.seq === event.record.seq)
          && (!terminal || (
            loaded.turns[0]?.status === "completed"
            && loaded.history.some((message) => message.role === "assistant")
          )),
      });
    });

    await host.send("session", "hello");
    expect(eventsAtHistorySnapshot).toEqual(["text-delta"]);
    expect(observations).toEqual([
      { type: "text-delta", durable: true },
      { type: "finish", durable: true },
    ]);
    expect(archive.listEvents("session")[0]?.event).toEqual({
      type: "text-delta",
      text: "onetwothree",
    });
    await host.close();
  });

  test("flushes coalesced deltas before non-delta events and terminal settlement", async () => {
    const archive = memoryArchive();
    const published: SessionEvent[] = [];
    const host = new TuiSessionHost({
      archive,
      deltaCoalesceIntervalMs: 1_000,
      runtimeFactory: (context) => new FakeSession(context, async (session) => {
        session.emit({ type: "text-delta", text: "a" });
        session.emit({ type: "text-delta", text: "b" });
        session.emit({ type: "reasoning-start", id: "r1" });
        session.emit({ type: "reasoning-delta", id: "r1", text: "x" });
        session.emit({ type: "reasoning-delta", id: "r1", text: "y" });
        session.emit({ type: "reasoning-delta", id: "r2", text: "z" });
        session.emit({ type: "reasoning-end", id: "r2" });
        session.emit({ type: "text-delta", text: "c" });
        session.emit({
          type: "subagent-event",
          toolCallId: "call",
          sessionId: "child",
          event: { type: "text-delta", text: "nested " },
        });
        session.emit({
          type: "subagent-event",
          toolCallId: "call",
          sessionId: "child",
          event: { type: "text-delta", text: "answer" },
        });
        session.emit({
          type: "subagent-finish",
          toolCallId: "call",
          sessionId: "child",
          result: "nested answer",
        });
        session.finish("done");
      }),
    });
    create(host, "session", "plan");
    host.subscribe((event) => {
      if (event.type === "session-event") published.push(event.event);
    });

    await host.send("session", "go");

    const durable = archive.listEvents("session").map((record) => record.event);
    expect(durable).toEqual([
      { type: "text-delta", text: "ab" },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", text: "xy" },
      { type: "reasoning-delta", id: "r2", text: "z" },
      { type: "reasoning-end", id: "r2" },
      { type: "text-delta", text: "c" },
      {
        type: "subagent-event",
        toolCallId: "call",
        sessionId: "child",
        event: { type: "text-delta", text: "nested answer" },
      },
      {
        type: "subagent-finish",
        toolCallId: "call",
        sessionId: "child",
        result: "nested answer",
      },
      { type: "finish", reason: "stop" },
    ]);
    expect(published).toEqual(durable);
    await host.close();
  });

  test("hydrates a lazily rebuilt runtime from archived model history", async () => {
    const temporary = createTemporarySessionArchive({ recoverInterrupted: false });
    const firstHost = new TuiSessionHost({
      archive: temporary.archive,
      runtimeFactory: (context) => new FakeSession(context, async (session) => session.finish("first answer")),
    });
    create(firstHost, "session", "plan");
    await firstHost.send("session", "first question");
    await firstHost.close();

    const reopened = new BunSQLiteSessionArchive({
      filename: temporary.filename,
      recoverInterrupted: false,
    });
    let hydrated: ModelMessage[] | undefined;
    const secondHost = new TuiSessionHost({
      archive: reopened,
      runtimeFactory: (context) => {
        hydrated = structuredClone(context.initialHistory);
        return new FakeSession(context, async (session) => session.finish("second answer"));
      },
    });
    expect(secondHost.listSessions()).toHaveLength(1);
    await secondHost.send("session", "second question");
    expect(hydrated?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(reopened.getModelHistory("session").map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    await secondHost.close();
    temporary.cleanup();
  });

  test("routes permission and question replies only to the addressed owner", async () => {
    const archive = memoryArchive();
    let interactive: FakeSession | undefined;
    const statuses: string[] = [];
    const host = new TuiSessionHost({
      archive,
      runtimeFactory: (context) => {
        if (context.metadata.id === "other") {
          return new FakeSession(context, async (session) => session.finish("other done"));
        }
        const runtime = new FakeSession(context, async (session) => {
          session.askPermission();
          await session.permissionGate.promise;
          session.askQuestion();
          await session.questionGate.promise;
          session.finish("answered");
        });
        if (context.metadata.id === "owner") interactive = runtime;
        return runtime;
      },
    });
    create(host, "owner", "plan");
    create(host, "other", "plan");
    host.subscribe((event) => {
      if (event.type === "status" && event.sessionID === "owner") statuses.push(event.status);
    });
    await host.send("other", "hydrate other");
    const turn = host.send("owner", "ask");
    await waitFor(() => host.pendingPermissions("owner").length === 1);

    expect(host.replyPermission("other", "per_1", "once")).toBe(false);
    expect(interactive!.permissionReplies).toEqual([]);
    expect(host.replyPermission("owner", "per_1", "once")).toBe(true);
    await waitFor(() => host.pendingQuestions("owner").length === 1);
    expect(host.answerQuestion("other", "qst_1", [["wrong"]])).toBe(false);
    expect(interactive!.questionAnswers).toEqual([]);
    expect(host.answerQuestion("owner", "qst_1", [["right"]])).toBe(true);
    await turn;

    expect(interactive!.permissionReplies).toEqual([["per_1", "once"]]);
    expect(interactive!.questionAnswers).toEqual([["qst_1", [["right"]]]]);
    expect(statuses).toEqual([
      "queued",
      "running",
      "waiting",
      "running",
      "waiting",
      "running",
      "settling",
      "idle",
    ]);
    await host.close();
  });
});

describe("TuiSessionHost filesystem history", () => {
  test("undoes and redoes plan turns without opening a filesystem engine", async () => {
    const archive = memoryArchive();
    let snapshotOpens = 0;
    const host = new TuiSessionHost({
      archive,
      openSnapshotEngine: async () => {
        snapshotOpens += 1;
        return { status: "unsupported", reason: "not-git-workspace" };
      },
      runtimeFactory: (context) => new FakeSession(context, async (session) => session.finish("answer")),
    });
    create(host, "session", "plan");
    await host.send("session", "question", { turnID: "plan-turn" });
    expect(archive.listTurns("session")[0]?.checkpoint.data).toMatchObject({
      filesystem: { status: "unavailable", reason: "plan-mode" },
    });

    const reverted = await host.undo("session");
    expect(reverted.visibleTurnCount).toBe(0);
    expect(archive.getModelHistory("session")).toEqual([]);
    expect(await host.redo("session")).toBeUndefined();
    expect(archive.getModelHistory("session").map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(snapshotOpens).toBe(0);
    await host.close();
  });

  test("refuses undo when a non-Git build has no filesystem checkpoint", async () => {
    const archive = memoryArchive();
    const host = new TuiSessionHost({
      archive,
      openSnapshotEngine: unsupportedSnapshots,
      runtimeFactory: (context) => new FakeSession(context, async (session) => session.finish("answer")),
    });
    create(host, "session", "build", "/not/a/repository");
    await host.send("session", "change things");
    const before = archive.getModelHistory("session");

    await expect(host.undo("session")).rejects.toMatchObject({ code: "ROLLBACK_UNAVAILABLE" });
    expect(archive.getSession("session")?.turnCount).toBe(1);
    expect(archive.getModelHistory("session")).toEqual(before);
    const rollback = archive.listTurns("session")[0]!.checkpoint.data as Record<string, unknown>;
    expect(rollback).toMatchObject({
      version: 1,
      filesystem: {
        status: "unavailable",
        reason: "not-git-workspace",
      },
    });
    expect(JSON.stringify(rollback)).toContain("external side effects");
    await host.close();
  });

  test("restores Git files before moving undo and redo conversation cursors", async () => {
    const fixture = await gitFixture("old");
    const archive = memoryArchive();
    const host = gitHost(archive, fixture, ["new"]);
    create(host, "session", "build", fixture.workspace);

    await host.send("session", "change file");
    expect(await fixture.read()).toBe("new");
    expect(archive.getSession("session")?.turnCount).toBe(1);
    const reverted = await host.undo("session");
    expect(await fixture.read()).toBe("old");
    expect(reverted.visibleTurnCount).toBe(0);
    expect(archive.getModelHistory("session")).toEqual([]);

    const redone = await host.redo("session");
    expect(redone).toBeUndefined();
    expect(await fixture.read()).toBe("new");
    expect(archive.getSession("session")?.turnCount).toBe(1);
    expect(archive.getModelHistory("session").map((message) => message.role)).toEqual(["user", "assistant"]);
    await host.close();
    await fixture.cleanup();
  });

  test("leaves conversation state unchanged when workspace restore conflicts", async () => {
    const fixture = await gitFixture("old");
    const archive = memoryArchive();
    const host = gitHost(archive, fixture, ["generated"]);
    create(host, "session", "build", fixture.workspace);
    await host.send("session", "change file");
    const history = archive.getModelHistory("session");
    await fixture.write("manual edit");

    await expect(host.undo("session")).rejects.toMatchObject({ code: "ROLLBACK_CONFLICT" });
    expect(await fixture.read()).toBe("manual edit");
    expect(archive.getSession("session")?.turnCount).toBe(1);
    expect(archive.getModelHistory("session")).toEqual(history);
    expect(archive.getRevertState("session")).toBeUndefined();
    await host.close();
    await fixture.cleanup();
  });

  test("compensates filesystem restores when undo or redo cursor mutation fails", async () => {
    const fixture = await gitFixture("old");
    const archive = memoryArchive();
    const host = gitHost(archive, fixture, ["new"]);
    create(host, "session", "build", fixture.workspace);
    await host.send("session", "change file");

    const undoToTurn = archive.undoToTurn.bind(archive);
    const undoError = new Error("undo cursor failed");
    archive.undoToTurn = () => {
      throw undoError;
    };
    await expect(host.undo("session")).rejects.toBe(undoError);
    expect(await fixture.read()).toBe("new");
    expect(archive.getRevertState("session")).toBeUndefined();

    archive.undoToTurn = undoToTurn;
    await host.undo("session");
    expect(await fixture.read()).toBe("old");
    const redoTurn = archive.redoTurn.bind(archive);
    const redoError = new Error("redo cursor failed");
    archive.redoTurn = () => {
      throw redoError;
    };
    await expect(host.redo("session")).rejects.toBe(redoError);
    expect(await fixture.read()).toBe("old");
    expect(archive.getRevertState("session")?.visibleTurnCount).toBe(0);

    archive.redoTurn = redoTurn;
    await host.close();
    await fixture.cleanup();
  });

  test("commits a reverted suffix before accepting a replacement branch", async () => {
    const fixture = await gitFixture("zero");
    const archive = memoryArchive();
    const host = gitHost(archive, fixture, ["one", "two", "replacement"]);
    create(host, "session", "build", fixture.workspace);
    await host.send("session", "first", { turnID: "first" });
    await host.send("session", "second", { turnID: "second" });
    expect(await fixture.read()).toBe("two");

    await host.undo("session");
    expect(await fixture.read()).toBe("one");
    await host.commitRevert("session");
    expect(archive.listTurns("session").map((turn) => turn.prompt)).toEqual(["first"]);
    await host.send("session", "new branch", { turnID: "replacement" });

    expect(await fixture.read()).toBe("replacement");
    expect(archive.listTurns("session").map((turn) => turn.prompt)).toEqual(["first", "new branch"]);
    expect(archive.getRevertState("session")).toBeUndefined();
    await host.close();
    await fixture.cleanup();
  });
});

describe("TuiSessionHost lifecycle", () => {
  test("evicts the least recently used settled runtime and refreshes runtimes on reuse", async () => {
    const archive = memoryArchive();
    const runtimes = new Map<string, FakeSession>();
    const host = new TuiSessionHost({
      archive,
      maxIdleRuntimes: 2,
      runtimeFactory: (context) => {
        const runtime = new FakeSession(context, async (session) => session.finish("answer"));
        runtimes.set(context.metadata.id, runtime);
        return runtime;
      },
    });
    create(host, "one", "plan");
    create(host, "two", "plan");
    create(host, "three", "plan");

    await host.send("one", "first");
    await host.send("two", "second");
    await host.send("one", "touch one again");
    await host.send("three", "third");

    expect(runtimes.get("one")?.closeCount).toBe(0);
    expect(runtimes.get("two")?.closeCount).toBe(1);
    expect(runtimes.get("three")?.closeCount).toBe(0);
    await host.close();
  });

  test("does not evict active runtimes or settled runtimes with pending interactions", async () => {
    const archive = memoryArchive();
    const activeGate = deferred<void>();
    let active: FakeSession | undefined;
    let pending: FakeSession | undefined;
    const host = new TuiSessionHost({
      archive,
      maxIdleRuntimes: 0,
      runtimeFactory: (context) => {
        if (context.metadata.id === "active") {
          active = new FakeSession(context, async (session) => {
            await activeGate.promise;
            session.finish("done");
          });
          return active;
        }
        pending = new FakeSession(context, async (session) => {
          session.askPermission();
          session.finish("waiting interaction");
        });
        return pending;
      },
    });
    create(host, "active", "plan");
    create(host, "pending", "plan");

    const running = host.send("active", "run");
    await waitFor(() => active !== undefined);
    expect(active?.closeCount).toBe(0);
    await host.send("pending", "ask");
    expect(active?.closeCount).toBe(0);
    expect(pending?.closeCount).toBe(0);
    activeGate.resolve();
    await running;
    expect(active?.closeCount).toBe(1);
    expect(pending?.closeCount).toBe(0);
    await host.close();
  });

  test("creates, updates, forks, loads, and deletes archived sessions", async () => {
    const archive = memoryArchive();
    const runtimes: FakeSession[] = [];
    const host = new TuiSessionHost({
      archive,
      runtimeFactory: (context) => {
        const runtime = new FakeSession(context, async (session) => session.finish("answer"));
        runtimes.push(runtime);
        return runtime;
      },
    });
    create(host, "source", "plan");
    expect(host.listSessions().map((session) => session.id)).toEqual(["source"]);
    await host.send("source", "hello");
    await host.setMode("source", "build");
    expect(runtimes[0]!.modes).toEqual(["build"]);
    const fork = await host.forkSession("source", { id: "fork" });
    expect(host.loadSession(fork.id)?.turns).toHaveLength(1);
    await host.setModel("source", { providerID: "other", modelID: "new" });
    expect(runtimes[0]!.closeCount).toBe(1);
    expect(await host.deleteSession("fork")).toBe(true);
    expect(host.loadSession("fork")).toBeUndefined();
    await host.close();
  });

  test("aborts, drains, closes, flushes, and closes the archive exactly once", async () => {
    const archive = memoryArchive();
    const archiveOrder: string[] = [];
    const originalFlush = archive.flush.bind(archive);
    const originalClose = archive.close.bind(archive);
    archive.flush = () => {
      archiveOrder.push("flush");
      originalFlush();
    };
    archive.close = () => {
      archiveOrder.push("archive-close");
      archive.flush = originalFlush;
      originalClose();
    };
    const runtimes: FakeSession[] = [];
    const host = new TuiSessionHost({
      archive,
      runtimeFactory: (context) => {
        const runtime = new FakeSession(context, async (session) => {
          await session.abortGate.promise;
          session.emit({ type: "finish", reason: "abort" });
        });
        runtime.onAbort = () => runtime.abortGate.resolve();
        runtimes.push(runtime);
        return runtime;
      },
    });
    create(host, "one", "plan");
    create(host, "two", "plan");
    void host.send("one", "first");
    void host.send("two", "second");
    await waitFor(() => runtimes.length === 2);

    const closing = host.close();
    expect(host.close()).toBe(closing);
    await closing;
    expect(runtimes.map((runtime) => [runtime.abortCount, runtime.closeCount])).toEqual([[2, 1], [2, 1]]);
    expect(archiveOrder).toEqual(["flush", "archive-close"]);
  });
});

class FakeSession implements TuiSessionLike {
  readonly id: string;
  readonly events = new AsyncEventQueue<SessionEvent>();
  readonly permissionReplies: Array<[string, PermissionReply]> = [];
  readonly questionAnswers: Array<[string, string[][]]> = [];
  readonly modes: AgentMode[] = [];
  readonly permissionGate = deferred<void>();
  readonly questionGate = deferred<void>();
  readonly abortGate = deferred<void>();
  abortCount = 0;
  closeCount = 0;
  onAbort?: () => void;
  onHistorySnapshot?: () => void;
  private readonly history: ModelMessage[];

  constructor(
    context: TuiRuntimeFactoryContext,
    private readonly run: (session: FakeSession, prompt: string) => Promise<void>,
  ) {
    this.id = context.metadata.id;
    this.history = structuredClone(context.initialHistory);
  }

  async send(prompt: string): Promise<void> {
    this.history.push({ role: "user", content: prompt });
    await this.run(this, prompt);
  }

  emit(event: SessionEvent): void {
    this.events.push(event);
  }

  finish(answer: string): void {
    this.history.push({ role: "assistant", content: answer });
    this.emit({ type: "finish", reason: "stop" });
  }

  askPermission(): void {
    const request: PermissionRequest = {
      id: "per_1",
      sessionId: this.id,
      permission: "edit",
      patterns: ["file.txt"],
      metadata: {},
      always: [],
    };
    this.emit({ type: "permission-asked", request });
  }

  askQuestion(): void {
    const request: QuestionRequest = {
      id: "qst_1",
      sessionId: this.id,
      questions: [{ question: "Which?", header: "Choice", options: [] }],
    };
    this.emit({ type: "question-asked", request });
  }

  snapshotHistory(): ModelMessage[] {
    this.onHistorySnapshot?.();
    return structuredClone(this.history);
  }

  abort(): void {
    this.abortCount += 1;
    this.onAbort?.();
  }

  close(): void {
    this.closeCount += 1;
    this.abort();
    this.events.close();
  }

  replyPermission(requestID: string, reply: PermissionReply): void {
    this.permissionReplies.push([requestID, reply]);
    this.emit({ type: "permission-replied", requestId: requestID, reply });
    this.permissionGate.resolve();
  }

  answerQuestion(requestID: string, answers: string[][]): void {
    this.questionAnswers.push([requestID, answers]);
    this.emit({ type: "question-answered", requestId: requestID, answers });
    this.questionGate.resolve();
  }

  rejectQuestion(requestID: string): void {
    this.emit({ type: "question-rejected", requestId: requestID });
    this.questionGate.resolve();
  }

  setModel(): void {}

  setMode(mode: AgentMode): void {
    this.modes.push(mode);
    this.emit({ type: "mode-change", mode });
  }

  setReasoningEffort(): void {}
}

function memoryArchive(): BunSQLiteSessionArchive {
  return BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
}

function create(
  host: TuiSessionHost,
  id: string,
  mode: AgentMode,
  workspace: string | null = "/workspace",
): void {
  host.createSession({
    id,
    title: id,
    workspace,
    model: { providerID: "test", modelID: "model" },
    mode,
    createdAt: 1,
  });
}

function sessionEvents<T extends SessionEvent["type"]>(
  events: TuiSessionHostEvent[],
  type: T,
): Array<Extract<TuiSessionHostEvent, { type: "session-event" }> & {
  event: Extract<SessionEvent, { type: T }>;
}> {
  return events.filter((event): event is Extract<TuiSessionHostEvent, { type: "session-event" }> & {
    event: Extract<SessionEvent, { type: T }>;
  } => event.type === "session-event" && event.event.type === type);
}

interface GitFixture {
  root: string;
  workspace: string;
  snapshots: string;
  read(): Promise<string>;
  write(value: string): Promise<void>;
  cleanup(): Promise<void>;
}

async function gitFixture(initial: string): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "cozycode-tui-runtime-"));
  const workspace = join(root, "workspace");
  const snapshots = join(root, "snapshots");
  const file = join(workspace, "file.txt");
  await mkdir(workspace);
  await writeFile(file, initial);
  const process = Bun.spawn(["git", "init", "-q", workspace], { stdout: "ignore", stderr: "pipe" });
  const exit = await process.exited;
  if (exit !== 0) throw new Error(await new Response(process.stderr).text());
  return {
    root,
    workspace,
    snapshots,
    read: () => readFile(file, "utf8"),
    write: (value) => writeFile(file, value),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function gitHost(
  archive: SessionArchive,
  fixture: GitFixture,
  writes: string[],
): TuiSessionHost {
  let index = 0;
  return new TuiSessionHost({
    archive,
    snapshotOptions: { storageRoot: fixture.snapshots },
    runtimeFactory: (context) => new FakeSession(context, async (session) => {
      const value = writes[index++];
      if (value === undefined) throw new Error("No deterministic fixture write remains.");
      await fixture.write(value);
      session.finish(`wrote ${value}`);
    }),
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("Timed out waiting for condition.");
}

function tick(): Promise<void> {
  return new Promise((resolveTick) => setTimeout(resolveTick, 0));
}
