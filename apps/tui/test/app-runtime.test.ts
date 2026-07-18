import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { openWorkspaceSnapshotEngine, type WorkspaceSnapshot } from "@cozycode/core";
import type { SessionConfig } from "@cozycode/protocol";
import {
  BunSQLiteSessionArchive,
  createTemporarySessionArchive,
  type JsonValue,
} from "@cozycode/sessions";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import {
  TUI_RECENT_EVENT_LIMIT,
  TUI_RECENT_TURN_LIMIT,
  TuiAppRuntime,
} from "../src/app-runtime.ts";

describe("TuiAppRuntime archive synchronization", () => {
  test("hydrates through the bounded replay API without loading model history", async () => {
    const archive = memoryArchive();
    createSession(archive, "session");
    const runtime = createRuntime(archive);
    const loadRecentSession = archive.loadRecentSession.bind(archive);
    const getModelHistory = archive.getModelHistory.bind(archive);
    let limits: { eventLimit: number; turnLimit: number } | undefined;
    let historyLoads = 0;
    archive.loadRecentSession = (sessionID, options) => {
      limits = options;
      return loadRecentSession(sessionID, options);
    };
    archive.loadSession = () => {
      throw new Error("full replay load should not be used for TUI hydration");
    };
    archive.getModelHistory = (sessionID) => {
      historyLoads += 1;
      return getModelHistory(sessionID);
    };

    runtime.hydrate("session");

    expect(limits).toEqual({
      eventLimit: TUI_RECENT_EVENT_LIMIT,
      turnLimit: TUI_RECENT_TURN_LIMIT,
    });
    expect(historyLoads).toBe(0);
    await runtime.close();
  });

  test("preserves archive-derived failure status during initial hydration", async () => {
    const archive = memoryArchive();
    createSession(archive, "failed");
    archive.acceptTurn({ sessionID: "failed", turnID: "failed-turn", prompt: "fail", acceptedAt: 2 });
    archive.settleTurn({
      sessionID: "failed",
      turnID: "failed-turn",
      status: "failed",
      settledAt: 3,
      terminalEvent: { type: "error", message: "failed" },
      history: [],
    });
    createSession(archive, "interrupted");
    archive.acceptTurn({
      sessionID: "interrupted",
      turnID: "interrupted-turn",
      prompt: "interrupt",
      acceptedAt: 2,
    });
    archive.recoverInterruptedTurns(3);
    const runtime = createRuntime(archive);

    runtime.hydrate("failed");
    runtime.hydrate("interrupted");

    expect(runtime.store.getState().viewsBySessionID.failed?.status).toBe("error");
    expect(runtime.store.getState().viewsBySessionID.interrupted?.status).toBe("error");
    await runtime.close();
  });

  test("refreshes terminal metadata without loading the full session", async () => {
    const archive = memoryArchive();
    createSession(archive, "session");
    const runtime = createRuntime(archive, textModel("answer"));
    const loadSession = archive.loadSession.bind(archive);
    let fullLoads = 0;
    archive.loadSession = (sessionID) => {
      fullLoads += 1;
      return loadSession(sessionID);
    };

    await runtime.host.send("session", "hello");

    expect(fullLoads).toBe(0);
    expect(runtime.store.getState().metadataByID.session?.turnCount).toBe(1);
    await runtime.close();
  });

  test("upgrades interrupted build and shell snapshots to ready checkpoints", async () => {
    const build = await gitFixture("old-build");
    const shell = await gitFixture("old-shell");
    const temporary = createTemporarySessionArchive({ recoverInterrupted: false });
    const storageRoot = resolve(dirname(build.workspace), ".cozycode-tui-test-snapshots");
    await prepareInterruptedTurn(temporary.archive, "build", build, "change things", "new-build", storageRoot);
    await prepareInterruptedTurn(temporary.archive, "shell", shell, "!change things", "new-shell", storageRoot);
    temporary.archive.close();
    const archive = new BunSQLiteSessionArchive({ filename: temporary.filename });
    const runtime = createRuntime(archive, textModel("unused"), build.workspace);

    const initialized = await runtime.initialize();

    expect(initialized.errors).toEqual([]);
    expect(rollbackStatus(archive, "build")).toBe("ready");
    expect(rollbackStatus(archive, "shell")).toBe("ready");
    await runtime.host.undo("build");
    await runtime.host.undo("shell");
    expect(await build.read()).toBe("old-build");
    expect(await shell.read()).toBe("old-shell");
    await runtime.close();
    temporary.cleanup();
    await Promise.all([build.cleanup(), shell.cleanup()]);
  });

  test("persists unavailable recovery instead of leaving an interrupted snapshot pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "cozycode-tui-recovery-unavailable-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const archive = memoryArchive();
    createSession(archive, "interrupted", workspace);
    archive.acceptTurn({
      sessionID: "interrupted",
      turnID: "interrupted-turn",
      prompt: "change things",
      acceptedAt: 2,
      rollbackData: pendingRollback(workspace, {
        workspaceId: "missing-workspace",
        tree: "before-tree",
        ref: "refs/cozycode/snapshots/before",
      }),
    });
    archive.recoverInterruptedTurns(3);
    const runtime = createRuntime(archive, textModel("unused"), workspace);

    const initialized = await runtime.initialize();

    expect(initialized.errors).toEqual([]);
    expect(archive.listTurns("interrupted")[0]?.checkpoint.data).toMatchObject({
      filesystem: { status: "unavailable", phase: "open", reason: "not-git-workspace" },
    });
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
});

function createRuntime(
  archive: BunSQLiteSessionArchive,
  model = textModel("unused"),
  workspaceRoot = "/workspace",
): TuiAppRuntime {
  const initialSession: SessionConfig = {
    provider: { name: "mock", baseURL: "http://localhost/v1" },
    model: "mock-model",
    workspaceRoot,
  };
  return new TuiAppRuntime({
    initialSession,
    initialModel: { providerID: "mock", modelID: "mock-model" },
    workspaceRoot,
    sessionOptions: { model },
    archive,
  }, archive, false);
}

function createSession(archive: BunSQLiteSessionArchive, id: string, workspace = "/workspace"): void {
  archive.createSession({
    id,
    title: id,
    workspace,
    model: { providerID: "mock", modelID: "mock-model" },
    mode: "build",
    createdAt: 1,
  });
}

function textModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: text },
          { type: "text-end", id: "text" },
          {
            type: "finish",
            finishReason: "stop",
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ] as LanguageModelV4StreamPart[],
      }),
    },
  });
}

function memoryArchive(): BunSQLiteSessionArchive {
  return BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
}

interface GitFixture {
  workspace: string;
  read(): Promise<string>;
  write(value: string): Promise<void>;
  cleanup(): Promise<void>;
}

async function gitFixture(initial: string): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "cozycode-tui-app-runtime-"));
  const workspace = join(root, "workspace");
  const file = join(workspace, "file.txt");
  await mkdir(workspace);
  await writeFile(file, initial);
  const process = Bun.spawn(["git", "init", "-q", workspace], { stdout: "ignore", stderr: "pipe" });
  const exit = await process.exited;
  if (exit !== 0) throw new Error(await new Response(process.stderr).text());
  return {
    workspace,
    read: () => readFile(file, "utf8"),
    write: (value) => writeFile(file, value),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function prepareInterruptedTurn(
  archive: BunSQLiteSessionArchive,
  sessionID: string,
  fixture: GitFixture,
  prompt: string,
  current: string,
  storageRoot: string,
): Promise<void> {
  createSession(archive, sessionID, fixture.workspace);
  const opened = await openWorkspaceSnapshotEngine(fixture.workspace, { storageRoot });
  if (opened.status !== "ready") throw new Error(`Could not open snapshot fixture: ${opened.reason}`);
  const captured = await opened.engine.capture();
  if (captured.status !== "captured") throw new Error(`Could not capture snapshot fixture: ${captured.reason}`);
  archive.acceptTurn({
    sessionID,
    turnID: `${sessionID}-turn`,
    prompt,
    acceptedAt: 2,
    rollbackData: pendingRollback(opened.workspaceRoot, captured.snapshot),
  });
  await fixture.write(current);
}

function pendingRollback(workspace: string, before: WorkspaceSnapshot): JsonValue {
  return {
    version: 1,
    filesystem: {
      status: "pending",
      workspace,
      before: { ...before },
      coverage: { scope: "workspace-files", changedPaths: [], omissions: [] },
      warnings: [],
    },
  };
}

function rollbackStatus(archive: BunSQLiteSessionArchive, sessionID: string): unknown {
  const data = archive.listTurns(sessionID)[0]?.checkpoint.data as Record<string, unknown> | undefined;
  return (data?.filesystem as Record<string, unknown> | undefined)?.status;
}
