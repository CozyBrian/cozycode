import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { rulesetFromConfig } from "@cozycode/core";
import { BunSQLiteSessionArchive, type ModelHistory } from "@cozycode/sessions";
import type { PermissionConfig, SessionConfig } from "@cozycode/protocol";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { App } from "../src/app.tsx";

const usage = {
  inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
} as const;
const tokenUsage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 } as const;
const renderers = new Set<TestRendererSetup>();
let originalConsoleError: typeof console.error;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-tui-sessions-"));
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

describe("durable session renderer", () => {
  test("hydrates archived replay and a versioned draft on restart", async () => {
    const archive = memoryArchive();
    createSession(archive, "persisted", "Persisted chat", 1);
    completeTurn(archive, "persisted", "turn", "remember me", "durable answer", 2);
    archive.saveDraft({
      sessionID: "persisted",
      createdAt: 6,
      text: JSON.stringify({
        version: 1,
        text: "restored draft",
        cursor: 8,
        promptMode: "normal",
        pastePlaceholders: [],
      }),
    });

    const rendered = await renderApp(archive, textModel("new answer"));
    await waitForFrame(rendered, "durable answer");
    const frame = rendered.captureCharFrame();
    expect(frame).toContain("remember me");
    expect(frame).toContain("restored draft");
  });

  test("keeps per-session drafts revision-safe across instant cache switches", async () => {
    const archive = memoryArchive();
    createSession(archive, "one", "Session one", 1);
    createSession(archive, "two", "Session two", 2);
    saveDraft(archive, "one", "draft one");
    saveDraft(archive, "two", "draft two");
    const rendered = await renderApp(archive, textModel("answer"));
    await waitForFrame(rendered, "draft two");

    await openSessions(rendered);
    await input(rendered, () => {
      rendered.mockInput.pressArrow("down");
      rendered.mockInput.pressEnter();
    });
    await waitForFrame(rendered, "draft one");
    await input(rendered, () => rendered.mockInput.typeText(" changed"));

    await openSessions(rendered);
    await input(rendered, () => {
      rendered.mockInput.pressArrow("up");
      rendered.mockInput.pressEnter();
    });
    await waitForFrame(rendered, "draft two");

    await openSessions(rendered);
    await input(rendered, () => {
      rendered.mockInput.pressArrow("down");
      rendered.mockInput.pressEnter();
    });
    await waitForFrame(rendered, "draft one changed");
    expect(rendered.captureCharFrame()).toContain("draft one changed");
  });

  test("continues generation in the background and marks completion unread", async () => {
    const archive = memoryArchive();
    createSession(archive, "other", "Other session", 1);
    createSession(archive, "worker", "Background worker", 2);
    saveDraft(archive, "other", "other draft");
    const rendered = await renderApp(archive, textModel("background complete", 500));

    await input(rendered, async () => {
      await rendered.mockInput.typeText("run in background");
      rendered.mockInput.pressEnter();
      rendered.mockInput.pressKey("x", { ctrl: true });
      rendered.mockInput.pressKey("l");
    });
    await waitForFrame(rendered, "Sessions");
    await input(rendered, () => {
      rendered.mockInput.pressArrow("down");
      rendered.mockInput.pressEnter();
    });
    await waitForFrame(rendered, "other draft");
    await waitFor(() => isTerminalTurn(archive.listTurns("worker")[0]?.status));
    expect(archive.listTurns("worker")[0]?.status).toBe("completed");
    expect(rendered.captureCharFrame()).not.toContain("background complete");

    rendered.resize(121, 30);
    await input(rendered, () => {});
    await waitForFrame(rendered, "unread");
    await openSessions(rendered);
    await input(rendered, () => {
      rendered.mockInput.pressArrow("up");
      rendered.mockInput.pressEnter();
    });
    await waitForFrame(rendered, "background complete");
    expect(rendered.captureCharFrame()).toContain("run in background");
  });

  test("shows pending permission only when its owning session is active", async () => {
    const archive = memoryArchive();
    createSession(archive, "other", "Other session", 1);
    createSession(archive, "owner", "Permission owner", 2);
    saveDraft(archive, "other", "other draft");
    const rendered = await renderApp(archive, twoStepWriteModel("owned"), { edit: "ask" });

    await input(rendered, async () => {
      await rendered.mockInput.typeText("write owned file");
      rendered.mockInput.pressEnter();
    });
    await waitForFrame(rendered, "Permission required");
    await openSessions(rendered);
    await input(rendered, () => {
      rendered.mockInput.pressArrow("down");
      rendered.mockInput.pressEnter();
    });
    await waitForFrame(rendered, "other draft");
    expect(rendered.captureCharFrame()).not.toContain("Permission required");

    await openSessions(rendered);
    await input(rendered, () => {
      rendered.mockInput.pressArrow("up");
      rendered.mockInput.pressEnter();
    });
    await waitForFrame(rendered, "Permission required");
    await input(rendered, () => rendered.mockInput.pressEnter());
    await waitFor(() => readFile(join(root, "out.txt"), "utf8").then(() => true, () => false));
    expect(await readFile(join(root, "out.txt"), "utf8")).toBe("owned");
  });
});

function createSession(archive: BunSQLiteSessionArchive, id: string, title: string, createdAt: number) {
  archive.createSession({
    id,
    title,
    workspace: root,
    model: { providerID: "mock", modelID: "mock-model" },
    mode: "build",
    createdAt,
  });
}

function completeTurn(
  archive: BunSQLiteSessionArchive,
  sessionID: string,
  turnID: string,
  prompt: string,
  answer: string,
  at: number,
) {
  archive.acceptTurn({ sessionID, turnID, prompt, acceptedAt: at });
  archive.appendEvent({
    sessionID,
    turnID,
    at: at + 1,
    event: { type: "text-delta", text: answer },
  });
  const history: ModelHistory = [
    { role: "user", content: prompt },
    { role: "assistant", content: answer },
  ];
  archive.settleTurn({
    sessionID,
    turnID,
    status: "completed",
    settledAt: at + 2,
    terminalEvent: { type: "finish", reason: "stop", usage: tokenUsage },
    history,
  });
}

function saveDraft(archive: BunSQLiteSessionArchive, sessionID: string, text: string) {
  archive.saveDraft({
    sessionID,
    text: JSON.stringify({
      version: 1,
      text,
      cursor: text.length,
      promptMode: "normal",
      pastePlaceholders: [],
    }),
  });
}

function config(permissions: PermissionConfig = "allow"): SessionConfig {
  return {
    provider: { name: "mock", baseURL: "http://localhost/v1" },
    model: "mock-model",
    workspaceRoot: root,
    permissions: rulesetFromConfig(permissions),
  };
}

async function renderApp(
  archive: BunSQLiteSessionArchive,
  model: MockLanguageModelV4,
  permissions: PermissionConfig = "allow",
) {
  const session = config(permissions);
  setActEnvironment(true);
  const rendered = await testRender(
    <App
      initialSession={session}
      initialModel={{ providerID: "mock", modelID: "mock-model" }}
      workspaceRoot={root}
      sessionOptions={{ model }}
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
  await waitForFrame(rendered, "mock-model");
  return rendered;
}

async function openSessions(rendered: TestRendererSetup) {
  await input(rendered, () => {
    rendered.mockInput.pressKey("x", { ctrl: true });
    rendered.mockInput.pressKey("l");
  });
  await waitForFrame(rendered, "Sessions");
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

async function waitFor(predicate: () => boolean | Promise<boolean>, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function textModel(text: string, delay = 0) {
  return new MockLanguageModelV4({
    doStream: {
      stream: simulateReadableStream({
        initialDelayInMs: delay,
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: text },
          { type: "text-end", id: "text" },
          { type: "finish", finishReason: "stop", usage },
        ] as LanguageModelV4StreamPart[],
      }),
    },
  });
}

function twoStepWriteModel(content: string) {
  const step = (chunks: LanguageModelV4StreamPart[]) => ({ stream: simulateReadableStream({ chunks }) });
  return new MockLanguageModelV4({
    doStream: [
      step([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "write_file",
          input: JSON.stringify({ path: "out.txt", content }),
        },
        { type: "finish", finishReason: "tool-calls", usage },
      ]),
      step([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: "done" },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: "stop", usage },
      ]),
    ],
  });
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
