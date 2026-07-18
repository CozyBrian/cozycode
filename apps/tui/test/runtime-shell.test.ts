import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncEventQueue, type ModelMessage, type ShellResult } from "@cozycode/core";
import type { AgentMode, SessionEvent } from "@cozycode/protocol";
import { BunSQLiteSessionArchive } from "@cozycode/sessions";
import {
  TuiSessionHost,
  type TuiRuntimeFactoryContext,
  type TuiSessionLike,
} from "../src/runtime/index.ts";

const unsupportedSnapshots = async () => ({
  status: "unsupported" as const,
  reason: "not-git-workspace" as const,
});

describe("TuiSessionHost direct shell turns", () => {
  test("stores a display prompt while sending the expanded prompt to the model", async () => {
    const archive = memoryArchive();
    let received = "";
    const host = new TuiSessionHost({
      archive,
      runtimeFactory: (context) => new FakeSession(context, async (session, prompt) => {
        received = prompt;
        session.finish("answer");
      }),
    });
    create(host, "session", "plan", "/workspace");

    await host.send("session", "Referenced file contents:\nsecret context", {
      turnID: "turn",
      displayPrompt: "Explain @file.ts",
    });

    expect(received).toBe("Referenced file contents:\nsecret context");
    expect(archive.listTurns("session")[0]?.prompt).toBe("Explain @file.ts");
    expect(archive.getModelHistory("session")[0]?.content).toBe("Referenced file contents:\nsecret context");
    await host.close();
  });

  test("persists successful and nonzero shell output and hydrates it into the next runtime", async () => {
    const archive = memoryArchive();
    const runtimes: FakeSession[] = [];
    const hydrated: ModelMessage[][] = [];
    const results: ShellResult[] = [
      {
        command: "printf success",
        exitCode: 0,
        stdout: "success\n",
        stderr: "",
        timedOut: false,
        truncated: false,
      },
      {
        command: "bad command",
        exitCode: 7,
        stdout: "partial",
        stderr: "failed\n",
        timedOut: false,
        truncated: true,
      },
    ];
    const host = new TuiSessionHost({
      archive,
      openSnapshotEngine: unsupportedSnapshots,
      shellExecutor: async (command, cwd, timeoutMs) => {
        expect(cwd).toBe("/workspace");
        expect(timeoutMs).toBe(1234);
        const result = results.shift();
        if (!result) throw new Error("No shell fixture result remains.");
        expect(command).toBe(result.command);
        return result;
      },
      runtimeFactory: (context) => {
        hydrated.push(structuredClone(context.initialHistory));
        const runtime = new FakeSession(context, async (session) => session.finish("model answer"));
        runtimes.push(runtime);
        return runtime;
      },
    });
    create(host, "session", "build", "/workspace");
    await host.send("session", "seed");
    const success = await host.shell("session", "printf success", { timeoutMs: 1234 });
    const nonzero = await host.shell("session", "!bad command", { timeoutMs: 1234 });

    expect(success.status).toBe("completed");
    expect(nonzero.status).toBe("completed");
    expect(runtimes[0]?.closeCount).toBe(1);
    expect(archive.listTurns("session").map((turn) => turn.prompt)).toEqual([
      "seed",
      "!printf success",
      "!bad command",
    ]);
    const toolResults = archive.listEvents("session")
      .filter((record): record is typeof record & {
        event: Extract<SessionEvent, { type: "tool-result" }>;
      } => record.event.type === "tool-result");
    expect(toolResults.map((record) => record.event.isError)).toEqual([false, true]);
    expect(toolResults[1]?.event.result).toEqual({
      command: "bad command",
      exitCode: 7,
      stdout: "partial",
      stderr: "failed\n",
      timedOut: false,
      truncated: true,
    });

    await host.send("session", "what happened?");
    expect(runtimes).toHaveLength(2);
    const rebuilt = hydrated[1]!;
    expect(JSON.stringify(rebuilt)).toContain("printf success");
    expect(JSON.stringify(rebuilt)).toContain("success");
    expect(JSON.stringify(rebuilt)).toContain("bad command");
    expect(JSON.stringify(rebuilt)).toContain("failed");
    expect(rebuilt.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    await host.close();
  });

  test("rejects shell execution after a queued switch to plan mode", async () => {
    const archive = memoryArchive();
    let executions = 0;
    const host = new TuiSessionHost({
      archive,
      openSnapshotEngine: unsupportedSnapshots,
      shellExecutor: async (command) => {
        executions += 1;
        return shellResult(command, 0, "must not run");
      },
      runtimeFactory: () => {
        throw new Error("A rejected direct shell turn must not create a model runtime.");
      },
    });
    create(host, "session", "build", "/workspace");

    const modeChange = host.setMode("session", "plan");
    const shellTurn = host.shell("session", "blocked");
    await modeChange;

    await expect(shellTurn).rejects.toMatchObject({ code: "READ_ONLY" });
    expect(executions).toBe(0);
    expect(archive.getSession("session")?.mode).toBe("plan");
    expect(archive.listTurns("session")).toEqual([]);
    await host.close();
  });

  test("restores a shell filesystem change through snapshot undo and redo", async () => {
    const fixture = await gitFixture("old");
    const archive = memoryArchive();
    const host = new TuiSessionHost({
      archive,
      snapshotOptions: { storageRoot: fixture.snapshots },
      shellExecutor: async (command, cwd) => {
        expect(cwd).toBe(fixture.workspace);
        await fixture.write("new");
        return shellResult(command, 0, "changed\n");
      },
      runtimeFactory: () => {
        throw new Error("A direct shell turn must not create a model runtime.");
      },
    });
    create(host, "session", "build", fixture.workspace);

    await host.shell("session", "change file");
    expect(await fixture.read()).toBe("new");
    const reverted = await host.undo("session");
    expect(reverted.visibleTurnCount).toBe(0);
    expect(await fixture.read()).toBe("old");
    await host.redo("session");
    expect(await fixture.read()).toBe("new");
    expect(archive.getSession("session")?.turnCount).toBe(1);
    await host.close();
    await fixture.cleanup();
  });

  test("aborts a running shell through AbortSignal and settles it durably", async () => {
    const archive = memoryArchive();
    const started = deferred<void>();
    let executorSignal: AbortSignal | undefined;
    const statuses: string[] = [];
    const host = new TuiSessionHost({
      archive,
      openSnapshotEngine: unsupportedSnapshots,
      shellExecutor: (command, _cwd, _timeoutMs, signal) => {
        executorSignal = signal;
        started.resolve();
        return new Promise((resolveResult) => {
          signal?.addEventListener("abort", () => {
            resolveResult({
              command,
              exitCode: null,
              stdout: "partial output",
              stderr: "aborted",
              timedOut: false,
              truncated: false,
            });
          }, { once: true });
        });
      },
      runtimeFactory: () => {
        throw new Error("A direct shell turn must not create a model runtime.");
      },
    });
    create(host, "session", "build", "/workspace");
    host.subscribe((event) => {
      if (event.type === "status") statuses.push(event.status);
    });

    const turn = host.shell("session", "long command");
    await started.promise;
    expect(host.abort("session")).toBe(true);
    const settled = await turn;

    expect(executorSignal?.aborted).toBe(true);
    expect(settled.status).toBe("aborted");
    expect(statuses).toEqual(["queued", "running", "settling", "idle"]);
    expect(archive.listEvents("session").map((record) => record.event.type)).toEqual([
      "tool-call-start",
      "tool-result",
      "finish",
    ]);
    expect(JSON.stringify(archive.getModelHistory("session"))).toContain("partial output");
    await host.close();
  });

  test("settles executor host failures as failed turns with a durable tool result", async () => {
    const archive = memoryArchive();
    const host = new TuiSessionHost({
      archive,
      openSnapshotEngine: unsupportedSnapshots,
      shellExecutor: async () => {
        throw new Error("spawn unavailable");
      },
      runtimeFactory: () => {
        throw new Error("A direct shell turn must not create a model runtime.");
      },
    });
    create(host, "session", "build", "/workspace");

    const settled = await host.shell("session", "cannot start");
    const result = archive.listEvents("session").find((record) => record.event.type === "tool-result");
    expect(settled.status).toBe("failed");
    expect(result?.event).toMatchObject({
      type: "tool-result",
      isError: true,
      result: { exitCode: null, stderr: "spawn unavailable" },
    });
    expect(archive.listEvents("session").at(-1)?.event).toEqual({
      type: "error",
      message: "spawn unavailable",
    });
    expect(JSON.stringify(archive.getModelHistory("session"))).toContain("spawn unavailable");
    await host.close();
  });

  test("serializes shell execution behind a model build in the same workspace", async () => {
    const archive = memoryArchive();
    const modelStarted = deferred<void>();
    const releaseModel = deferred<void>();
    const shellStarted = deferred<void>();
    let shellRunning = false;
    const host = new TuiSessionHost({
      archive,
      openSnapshotEngine: unsupportedSnapshots,
      shellExecutor: async (command) => {
        shellRunning = true;
        shellStarted.resolve();
        return shellResult(command, 0, "done");
      },
      runtimeFactory: (context) => new FakeSession(context, async (session) => {
        modelStarted.resolve();
        await releaseModel.promise;
        session.finish("model done");
      }),
    });
    create(host, "model", "build", "/same/workspace");
    create(host, "shell", "build", "/same/workspace");

    const modelTurn = host.send("model", "build");
    await modelStarted.promise;
    await expect(host.shell("model", "same session")).rejects.toMatchObject({ code: "BUSY" });
    const shellTurn = host.shell("shell", "after model");
    await tick();
    expect(shellRunning).toBe(false);
    releaseModel.resolve();
    await shellStarted.promise;
    await Promise.all([modelTurn, shellTurn]);
    await host.close();
  });

  test("persists shell tool events before fanout and history before terminal publication", async () => {
    const archive = memoryArchive();
    const observations: Array<[string, boolean]> = [];
    const host = new TuiSessionHost({
      archive,
      openSnapshotEngine: unsupportedSnapshots,
      shellExecutor: async (command) => shellResult(command, 0, "durable output"),
      runtimeFactory: () => {
        throw new Error("A direct shell turn must not create a model runtime.");
      },
    });
    create(host, "session", "build", "/workspace");
    host.subscribe((event) => {
      if (event.type !== "session-event") return;
      const loaded = archive.loadSession("session")!;
      const terminal = event.event.type === "finish" || event.event.type === "error";
      observations.push([
        event.event.type,
        loaded.events.some((record) => record.seq === event.record.seq)
          && (!terminal || (
            loaded.turns[0]?.status === "completed"
            && JSON.stringify(loaded.history).includes("durable output")
          )),
      ]);
    });

    await host.shell("session", "durable");
    expect(observations).toEqual([
      ["tool-call-start", true],
      ["tool-result", true],
      ["finish", true],
    ]);
    await host.close();
  });
});

class FakeSession implements TuiSessionLike {
  readonly id: string;
  readonly events = new AsyncEventQueue<SessionEvent>();
  closeCount = 0;
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

  finish(answer: string): void {
    this.history.push({ role: "assistant", content: answer });
    this.events.push({ type: "finish", reason: "stop" });
  }

  snapshotHistory(): ModelMessage[] {
    return structuredClone(this.history);
  }

  abort(): void {}

  close(): void {
    this.closeCount += 1;
    this.events.close();
  }
}

function memoryArchive(): BunSQLiteSessionArchive {
  return BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
}

function create(
  host: TuiSessionHost,
  id: string,
  mode: AgentMode,
  workspace: string,
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

function shellResult(command: string, exitCode: number, stdout: string): ShellResult {
  return {
    command,
    exitCode,
    stdout,
    stderr: "",
    timedOut: false,
    truncated: false,
  };
}

interface GitFixture {
  workspace: string;
  snapshots: string;
  read(): Promise<string>;
  write(value: string): Promise<void>;
  cleanup(): Promise<void>;
}

async function gitFixture(initial: string): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "cozycode-tui-shell-"));
  const workspace = join(root, "workspace");
  const snapshots = join(root, "snapshots");
  const file = join(workspace, "file.txt");
  await mkdir(workspace);
  await writeFile(file, initial);
  const process = Bun.spawn(["git", "init", "-q", workspace], { stdout: "ignore", stderr: "pipe" });
  const exit = await process.exited;
  if (exit !== 0) throw new Error(await new Response(process.stderr).text());
  return {
    workspace,
    snapshots,
    read: () => readFile(file, "utf8"),
    write: (value) => writeFile(file, value),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
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

function tick(): Promise<void> {
  return new Promise((resolveTick) => setTimeout(resolveTick, 0));
}
