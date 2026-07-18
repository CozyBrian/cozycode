import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { BunSQLiteSessionArchive } from "@cozycode/sessions";
import { rulesetFromConfig } from "@cozycode/core";
import type { PermissionConfig, SessionConfig } from "@cozycode/protocol";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { App } from "../src/app.tsx";
import { Markdown } from "../src/components/Markdown.tsx";
import { Reasoning } from "../src/components/Reasoning.tsx";
import { ToolRow } from "../src/components/ToolRow.tsx";
import { Viewport } from "../src/components/Viewport.tsx";

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
} as const;
const renderers = new Set<TestRendererSetup>();
let originalConsoleError: typeof console.error;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-tui-app-"));
  process.env.COZY_STATE_FILE = join(root, "tui-state.json");
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

describe("durable TUI app routing", () => {
  test("routes prompts with workspace references while retaining the display prompt", async () => {
    await writeFile(join(root, "notes.txt"), "durable context\n");
    const archive = memoryArchive();
    const rendered = await renderApp(archive, textModel("Referenced."));

    await input(rendered, async () => {
      await rendered.mockInput.typeText("Explain @notes.txt ");
      rendered.mockInput.pressEnter();
    });
    await waitFor(() => archive.listSessions()[0]?.turnCount === 1);

    const session = archive.listSessions()[0]!;
    expect(archive.listTurns(session.id)[0]?.prompt).toBe("Explain @notes.txt ");
    expect(JSON.stringify(archive.getModelHistory(session.id))).toContain("durable context");
    expect(rendered.captureCharFrame()).toContain("Referenced.");
  });

  test("routes slash input through shared commands without creating a turn", async () => {
    const archive = memoryArchive();
    const rendered = await renderApp(archive, textModel("must not run"));

    await input(rendered, async () => {
      await rendered.mockInput.typeText("/plan ");
      rendered.mockInput.pressEnter();
    });
    await waitFor(() => archive.listSessions()[0]?.mode === "plan");

    expect(archive.listSessions()[0]?.mode).toBe("plan");
    expect(archive.listTurns(archive.listSessions()[0]!.id)).toEqual([]);
    expect(rendered.captureCharFrame()).toContain("PLAN");

    await input(rendered, async () => {
      await rendered.mockInput.typeText("/bogus ");
      rendered.mockInput.pressEnter();
    });
    await waitForFrame(rendered, "Unknown command: /bogus");
  });

  test("routes leading bang through durable shell turns", async () => {
    const archive = memoryArchive();
    const rendered = await renderApp(archive, textModel("unused"));

    await input(rendered, async () => {
      await rendered.mockInput.typeText("!");
      await rendered.mockInput.typeText("printf routed > shell.txt");
      rendered.mockInput.pressEnter();
    });
    await waitFor(async () => readFile(join(root, "shell.txt"), "utf8").then(() => true, () => false));

    const session = archive.listSessions()[0]!;
    expect(archive.listTurns(session.id)[0]?.prompt).toBe("!printf routed > shell.txt");
    expect(await readFile(join(root, "shell.txt"), "utf8")).toBe("routed");
    expect(rendered.captureCharFrame()).toContain("$ printf routed > shell.txt");
  });

  test("keeps permission-gated tools owned by the active durable session", async () => {
    const archive = memoryArchive();
    const rendered = await renderApp(archive, twoStepWriteModel("approved"), { edit: "ask" });

    await input(rendered, async () => {
      await rendered.mockInput.typeText("write the file");
      rendered.mockInput.pressEnter();
    });
    await waitForFrame(rendered, "Permission required");
    expect(await fileExists("out.txt")).toBe(false);

    await input(rendered, () => rendered.mockInput.pressEnter());
    await waitFor(() => fileExists("out.txt"));
    expect(await readFile(join(root, "out.txt"), "utf8")).toBe("approved");
  });
});

describe("existing transcript presentation", () => {
  test("shows when bounded hydration omitted earlier transcript events", async () => {
    const rendered = await render(
      <box width={80} height={5} flexDirection="column">
        <Viewport items={[]} inputEnabled={false} earlierItemsOmitted />
      </box>,
      80,
      5,
    );
    expect(rendered.captureCharFrame()).toContain("Earlier transcript omitted. Showing recent activity.");
  });

  test("renders compact tool rows", async () => {
    const rendered = await render(
      <box width={100} flexDirection="column">
        <ToolRow
          item={{
            id: "search",
            kind: "tool",
            toolCallId: "search",
            toolName: "search",
            args: { pattern: "TODO", path: "src" },
            status: "done",
            result: { matches: ["src/a.ts:1:// TODO", "src/b.ts:2:// TODO"] },
          }}
        />
        <ToolRow
          item={{
            id: "shell",
            kind: "tool",
            toolCallId: "shell",
            toolName: "run_shell",
            args: { command: "bun test", cwd: "apps/tui" },
            status: "done",
            result: { stdout: "10 pass", stderr: "", timedOut: false, truncated: false },
          }}
        />
      </box>,
      100,
      12,
    );
    const frame = rendered.captureCharFrame();
    expect(frame).toContain('Grep "TODO" in src (2 matches)');
    expect(frame).toContain("$ bun test");
    expect(frame).toContain("10 pass");
  });

  test("renders markdown and collapsed reasoning", async () => {
    const rendered = await render(
      <box width={80} height={10} flexDirection="column">
        <Markdown text={"**Done**\n\n- item"} />
        <Reasoning
          item={{
            id: "reasoning",
            kind: "reasoning",
            reasoningId: "r1",
            text: "secret body",
            streaming: false,
            durationMs: 4200,
          }}
        />
      </box>,
      80,
      10,
    );
    await waitForFrame(rendered, "item");
    const frame = rendered.captureCharFrame();
    expect(frame).toContain("Done");
    expect(frame).toContain("Thought");
    expect(frame).not.toContain("secret body");
  });
});

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
  const rendered = await render(
    <App
      initialSession={session}
      initialModel={{ providerID: "mock", modelID: "mock-model" }}
      workspaceRoot={root}
      sessionOptions={{ model }}
      archive={archive}
      onExit={() => {}}
    />,
    100,
    30,
  );
  await waitForFrame(rendered, "Ask anything");
  return rendered;
}

async function render(element: React.ReactNode, width: number, height: number) {
  setActEnvironment(true);
  const rendered = await testRender(element, { width, height, kittyKeyboard: true, exitOnCtrlC: false });
  renderers.add(rendered);
  await act(async () => {
    await rendered.flush();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rendered.flush();
  });
  setActEnvironment(false);
  return rendered;
}

async function input(rendered: TestRendererSetup, callback: () => void | Promise<void>) {
  await callback();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await rendered.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rendered.flush();
}

async function waitForFrame(rendered: TestRendererSetup, text: string): Promise<void> {
  await waitFor(async () => {
    await rendered.flush();
    return rendered.captureCharFrame().includes(text);
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, attempts = 150): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

function memoryArchive(): BunSQLiteSessionArchive {
  return BunSQLiteSessionArchive.inMemory({ recoverInterrupted: false });
}

function textModel(text: string) {
  return new MockLanguageModelV4({
    doStream: step([
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
        { type: "text-delta", id: "text", delta: "Done writing." },
        { type: "text-end", id: "text" },
        { type: "finish", finishReason: "stop", usage },
      ]),
    ],
  });
}

function step(parts: LanguageModelV4StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts }) };
}

function fileExists(name: string) {
  return readFile(join(root, name), "utf8").then(() => true, () => false);
}

function setActEnvironment(value: boolean) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = value;
}
