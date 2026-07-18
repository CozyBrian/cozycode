import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { rulesetFromConfig } from "@cozycode/core";
import { BunSQLiteSessionArchive, type ModelHistory } from "@cozycode/sessions";
import type { ProviderList, SessionConfig } from "@cozycode/protocol";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { App } from "../src/app.tsx";

const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
} as const;
const renderers = new Set<TestRendererSetup>();
let originalConsoleError: typeof console.error;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-tui-actions-"));
  process.env.COZY_STATE_FILE = join(root, "state.json");
  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (message.includes("not wrapped in act")) return;
    originalConsoleError(...args);
  };
});

afterEach(async () => {
  for (const rendered of renderers) rendered.renderer.destroy();
  renderers.clear();
  console.error = originalConsoleError;
  setActEnvironment(true);
  delete process.env.COZY_STATE_FILE;
  await rm(root, { recursive: true, force: true });
});

describe("TUI action registry integration", () => {
  test("uses ctrl+x leader shortcuts and retains direct ctrl+p", async () => {
    const archive = memoryArchive();
    const rendered = await renderConfigured(archive, textModel("answer"));

    await leader(rendered, "m");
    await waitForFrame(rendered, "Switch model");
    await input(rendered, () => rendered.mockInput.pressEscape());

    await leader(rendered, "p");
    await waitForFrame(rendered, "Commands");
    await input(rendered, () => rendered.mockInput.pressEscape());

    await leader(rendered, "?");
    await waitForFrame(rendered, "Keyboard");
    await input(rendered, () => rendered.mockInput.pressEscape());

    await leader(rendered, "n");
    await waitFor(() => archive.listSessions().length === 2);
    await leader(rendered, "l");
    await waitForFrame(rendered, "Sessions");
    await input(rendered, () => rendered.mockInput.pressEscape());

    await input(rendered, () => rendered.mockInput.pressKey("p", { ctrl: true }));
    await waitForFrame(rendered, "Commands");
  });

  test("uses the AppShell breakpoint and leader sidebar override", async () => {
    const rendered = await renderConfigured(memoryArchive(), textModel("answer"), root, 100);
    expect(rendered.captureCharFrame()).not.toContain("Context");

    rendered.resize(121, 30);
    await input(rendered, () => {});
    await waitForFrame(rendered, "Context");

    rendered.resize(120, 30);
    await input(rendered, () => {});
    await waitFor(() => !rendered.captureCharFrame().includes("Context"));
    await leader(rendered, "b");
    await waitForFrame(rendered, "Context");
  });

  test("keeps provider onboarding available without a session or model", async () => {
    const archive = memoryArchive();
    const emptyProviders: ProviderList = { all: [], connected: [] };
    setActEnvironment(true);
    const rendered = await testRender(
      <App
        initialSession={null}
        initialModel={null}
        workspaceRoot={root}
        sessionOptions={{ model: textModel("unused") }}
        testProviders={emptyProviders}
        archive={archive}
        onExit={() => {}}
      />,
      { width: 100, height: 30, kittyKeyboard: true, exitOnCtrlC: false },
    );
    renderers.add(rendered);
    await act(async () => {
      await rendered.flush();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await rendered.flush();
    });
    setActEnvironment(false);
    await waitForFrame(rendered, "Providers");
    expect(archive.listSessions()).toEqual([]);
    expect(rendered.captureCharFrame()).toContain("Add custom provider");
  });

  test("clears a nonempty composer before deterministic one-time exit", async () => {
    const archive = memoryArchive();
    const order: string[] = [];
    const originalClose = archive.close.bind(archive);
    archive.close = () => {
      order.push("archive-close");
      originalClose();
    };
    const rendered = await renderConfigured(
      archive,
      textModel("answer"),
      root,
      100,
      async () => {
        order.push("exit");
      },
    );

    await input(rendered, () => rendered.mockInput.typeText("keep me"));
    await waitForFrame(rendered, "keep me");
    await input(rendered, () => rendered.mockInput.pressKey("c", { ctrl: true }));
    expect(order).toEqual([]);
    expect(rendered.captureCharFrame()).not.toContain("keep me");

    await input(rendered, () => rendered.mockInput.pressKey("c", { ctrl: true }));
    await waitFor(() => order.includes("exit"));
    expect(order).toEqual(["archive-close", "exit"]);
  });
});

describe("rollback actions", () => {
  test("undo and redo restore files and authoritatively replace visible replay", async () => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "tracked.txt"), "old");
    const git = Bun.spawn(["git", "init", "-q", workspace], { stdout: "ignore", stderr: "pipe" });
    if (await git.exited !== 0) throw new Error(await new Response(git.stderr).text());

    const archive = memoryArchive();
    const rendered = await renderConfigured(archive, twoStepWriteModel("new"), workspace);
    await input(rendered, async () => {
      await rendered.mockInput.typeText("change tracked file");
      rendered.mockInput.pressEnter();
    });
    await waitFor(() => readFile(join(workspace, "tracked.txt"), "utf8").then((text) => text === "new"));
    await waitFor(() => isTerminalTurn(archive.listTurns(archive.listSessions()[0]!.id)[0]?.status));
    expect(archive.listTurns(archive.listSessions()[0]!.id)[0]?.status).toBe("completed");
    await waitForFrame(rendered, "Done writing");

    let undoCalls = 0;
    const undoToTurn = archive.undoToTurn.bind(archive);
    archive.undoToTurn = (...args) => {
      undoCalls++;
      return undoToTurn(...args);
    };
    await input(rendered, () => {
      rendered.mockInput.pressKey("x", { ctrl: true });
      rendered.mockInput.pressKey("u");
      rendered.mockInput.pressKey("x", { ctrl: true });
      rendered.mockInput.pressKey("u");
    });
    await waitFor(() => readFile(join(workspace, "tracked.txt"), "utf8").then((text) => text === "old", () => false));
    await waitFor(() => archive.listSessions()[0]?.turnCount === 0);
    expect(undoCalls).toBe(1);
    expect(rendered.captureCharFrame()).not.toContain("Done writing");

    await leader(rendered, "r");
    await waitFor(() => readFile(join(workspace, "tracked.txt"), "utf8").then((text) => text === "new", () => false));
    await waitForFrame(rendered, "Done writing");
    expect(archive.listSessions()[0]?.turnCount).toBe(1);
  });
});

describe("timeline and draft actions", () => {
  test("returns from a timeline action to the timeline on Escape or Back", async () => {
    const archive = memoryArchive();
    seedArchivedTurn(archive, "turn", "original prompt", [
      { role: "user", content: "original prompt" },
      { role: "assistant", content: "answer" },
    ]);
    const rendered = await renderConfigured(archive, textModel("unused"));

    await leader(rendered, "g");
    await waitForFrame(rendered, "Message timeline");
    await input(rendered, () => rendered.mockInput.pressEnter());
    await waitForFrame(rendered, "Filesystem changes are restored");
    await input(rendered, () => rendered.mockInput.pressEscape());
    await waitForFrame(rendered, "Message timeline");

    await input(rendered, () => rendered.mockInput.pressEnter());
    await input(rendered, () => rendered.mockInput.pressArrow("down"));
    await input(rendered, () => rendered.mockInput.pressArrow("down"));
    await input(rendered, () => rendered.mockInput.pressEnter());
    await waitForFrame(rendered, "Message timeline");
  });

  test("materializes paste metadata when forking and ignores repeated confirmation", async () => {
    const archive = memoryArchive();
    const rendered = await renderConfigured(archive, textModel("answer"));
    await input(rendered, async () => {
      await rendered.mockInput.pasteBracketedText("one\ntwo\nthree");
      rendered.mockInput.pressEnter();
    });
    const sourceID = archive.listSessions()[0]!.id;
    await waitFor(() => isTerminalTurn(archive.listTurns(sourceID)[0]?.status));

    let forkCalls = 0;
    const forkFromTurn = archive.forkFromTurn.bind(archive);
    archive.forkFromTurn = (...args) => {
      forkCalls++;
      return forkFromTurn(...args);
    };
    await leader(rendered, "g");
    await input(rendered, () => rendered.mockInput.pressEnter());
    await input(rendered, () => rendered.mockInput.pressArrow("down"));
    await input(rendered, () => {
      rendered.mockInput.pressEnter();
      rendered.mockInput.pressEnter();
    });

    await waitFor(() => archive.listSessions().length === 2);
    await waitForFrame(rendered, "one");
    expect(forkCalls).toBe(1);
    expect(rendered.captureCharFrame()).toContain("three");
    expect(rendered.captureCharFrame()).not.toContain("[Pasted ~3 lines]");
  });

  test("falls back to the archived model prompt and strips shell bang on fork", async () => {
    const pasteArchive = memoryArchive();
    seedArchivedTurn(pasteArchive, "paste", "[Pasted ~3 lines]", [
      { role: "user", content: [{ type: "text", text: "full\nstored\nprompt" }] },
      { role: "assistant", content: "answer" },
    ]);
    const pasteRendered = await renderConfigured(pasteArchive, textModel("unused"));
    await forkLatestTurn(pasteRendered);
    await waitForFrame(pasteRendered, "stored");
    expect(pasteRendered.captureCharFrame()).not.toContain("[Pasted ~3 lines]");

    pasteRendered.renderer.destroy();
    renderers.delete(pasteRendered);

    const shellArchive = memoryArchive();
    seedArchivedTurn(shellArchive, "shell", "!echo hello", [
      { role: "user", content: "Direct shell command:\n\"echo hello\"" },
      { role: "assistant", content: "Direct shell result:\n{}" },
    ]);
    const shellRendered = await renderConfigured(shellArchive, textModel("unused"));
    await forkLatestTurn(shellRendered);
    await waitForFrame(shellRendered, "SHELL");
    expect(shellRendered.captureCharFrame()).toContain("echo hello");
    expect(shellRendered.captureCharFrame()).not.toContain("!echo hello");
  });

  test("materializes tracked pastes before opening the external editor", async () => {
    const archive = memoryArchive();
    const editorScript = join(root, "editor.mjs");
    const captured = join(root, "editor-input.txt");
    await writeFile(
      editorScript,
      `import { copyFileSync } from "node:fs";\ncopyFileSync(process.argv.at(-1), ${JSON.stringify(captured)});\n`,
    );
    const previousVisual = process.env.VISUAL;
    process.env.VISUAL = `${JSON.stringify(process.execPath)} ${JSON.stringify(editorScript)}`;
    try {
      const rendered = await renderConfigured(archive, textModel("unused"));
      await input(rendered, () => rendered.mockInput.pasteBracketedText("editor\ngets\nfull text"));
      await leader(rendered, "e");
      await waitFor(() => readFile(captured, "utf8").then(() => true, () => false));
      expect(await readFile(captured, "utf8")).toBe("editor\ngets\nfull text");
      await waitForFrame(rendered, "editor");
      expect(rendered.captureCharFrame()).not.toContain("[Pasted ~3 lines]");
    } finally {
      if (previousVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = previousVisual;
    }
  });

  test("deletes a session only once on repeated confirmation", async () => {
    const archive = memoryArchive();
    const rendered = await renderConfigured(archive, textModel("unused"));
    let deleteCalls = 0;
    const deleteSession = archive.deleteSession.bind(archive);
    archive.deleteSession = (...args) => {
      deleteCalls++;
      return deleteSession(...args);
    };

    await leader(rendered, "l");
    await input(rendered, () => rendered.mockInput.pressKey("d", { ctrl: true }));
    await waitForFrame(rendered, "Delete session?");
    await input(rendered, () => rendered.mockInput.pressArrow("down"));
    await input(rendered, () => {
      rendered.mockInput.pressEnter();
      rendered.mockInput.pressEnter();
    });
    await waitFor(() => deleteCalls > 0);
    expect(deleteCalls).toBe(1);
  });
});

function config(workspace: string): SessionConfig {
  return {
    provider: { name: "mock", baseURL: "http://localhost/v1" },
    model: "mock-model",
    workspaceRoot: workspace,
    permissions: rulesetFromConfig("allow"),
  };
}

function seedArchivedTurn(
  archive: BunSQLiteSessionArchive,
  sessionID: string,
  prompt: string,
  history: ModelHistory,
) {
  archive.createSession({
    id: sessionID,
    title: "Archived turn",
    workspace: root,
    model: { providerID: "mock", modelID: "mock-model" },
    mode: "build",
    createdAt: 1,
  });
  archive.acceptTurn({ sessionID, turnID: `${sessionID}-turn`, prompt, acceptedAt: 2 });
  archive.appendEvent({
    sessionID,
    turnID: `${sessionID}-turn`,
    at: 3,
    event: { type: "text-delta", text: "answer" },
  });
  archive.settleTurn({
    sessionID,
    turnID: `${sessionID}-turn`,
    status: "completed",
    settledAt: 4,
    terminalEvent: { type: "finish", reason: "stop" },
    history,
  });
}

async function forkLatestTurn(rendered: TestRendererSetup) {
  await leader(rendered, "g");
  await input(rendered, () => rendered.mockInput.pressEnter());
  await input(rendered, () => rendered.mockInput.pressArrow("down"));
  await input(rendered, () => rendered.mockInput.pressEnter());
}

async function renderConfigured(
  archive: BunSQLiteSessionArchive,
  model: MockLanguageModelV4,
  workspace = root,
  width = 100,
  onExit: () => void | Promise<void> = () => {},
) {
  const session = config(workspace);
  setActEnvironment(true);
  const rendered = await testRender(
    <App
      initialSession={session}
      initialModel={{ providerID: "mock", modelID: "mock-model" }}
      workspaceRoot={workspace}
      sessionOptions={{ model }}
      testEfforts={["low", "medium", "high"]}
      archive={archive}
      onExit={onExit}
    />,
    { width, height: 30, kittyKeyboard: true, exitOnCtrlC: false },
  );
  renderers.add(rendered);
  await act(async () => {
    await rendered.flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rendered.flush();
  });
  setActEnvironment(false);
  await waitForFrame(rendered, "mock-model");
  return rendered;
}

async function leader(rendered: TestRendererSetup, key: string) {
  await input(rendered, () => {
    rendered.mockInput.pressKey("x", { ctrl: true });
    rendered.mockInput.pressKey(key);
  });
}

async function input(rendered: TestRendererSetup, callback: () => void | Promise<void>) {
  await callback();
  await new Promise((resolve) => setTimeout(resolve, 35));
  await rendered.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rendered.flush();
}

async function waitForFrame(rendered: TestRendererSetup, text: string) {
  try {
    await waitFor(async () => {
      await rendered.flush();
      return rendered.captureCharFrame().includes(text);
    });
  } catch {
    await rendered.flush();
    throw new Error(`Timed out waiting for ${JSON.stringify(text)} in frame:\n${rendered.captureCharFrame()}`);
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, attempts = 250) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function textModel(text: string) {
  return new MockLanguageModelV4({
    doStream: stream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text" },
      { type: "text-delta", id: "text", delta: text },
      { type: "text-end", id: "text" },
      { type: "finish", finishReason: "stop", usage },
    ]),
  });
}

function twoStepWriteModel(content: string) {
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "write_file",
          input: JSON.stringify({ path: "tracked.txt", content }),
        },
        { type: "finish", finishReason: "tool-calls", usage },
      ]),
      stream([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "Done writing." },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: "stop", usage },
      ]),
    ],
  });
}

function stream(chunks: LanguageModelV4StreamPart[]) {
  return { stream: simulateReadableStream({ chunks }) };
}

function memoryArchive() {
  return BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
}

function isTerminalTurn(status: string | undefined) {
  return status === "completed" || status === "failed" || status === "aborted";
}

function setActEnvironment(value: boolean) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = value;
}
