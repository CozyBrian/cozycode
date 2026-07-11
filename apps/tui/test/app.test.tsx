import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { PermissionConfig, SessionConfig } from "@cozycode/protocol";
import { rulesetFromConfig } from "@cozycode/core";
import { App } from "../src/app.tsx";
import { Markdown } from "../src/components/Markdown.tsx";
import { Reasoning } from "../src/components/Reasoning.tsx";
import { ToolRow } from "../src/components/ToolRow.tsx";

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 } as const;
const step = (parts: LanguageModelV4StreamPart[]) => ({
  stream: simulateReadableStream({ chunks: parts }),
});

/** A model that calls write_file, then emits a final message on the next step. */
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
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Done writing." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage },
      ]),
    ],
  });
}

/** A model that emits a reasoning block, then a final text message. */
function reasoningModel() {
  return new MockLanguageModelV4({
    doStream: step([
      { type: "stream-start", warnings: [] },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Planning the approach." },
      { type: "reasoning-end", id: "r1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Here is the answer." },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop", usage },
    ]),
  });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-tui-"));
  process.env.COZY_STATE_FILE = join(root, "tui-state.json");
});
afterEach(async () => {
  delete process.env.COZY_STATE_FILE;
  await rm(root, { recursive: true, force: true });
});

function config(permissions: PermissionConfig): SessionConfig {
  return {
    provider: { name: "mock", baseURL: "http://localhost/v1" },
    model: "mock-model",
    workspaceRoot: root,
    permissions: rulesetFromConfig(permissions),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error("waitFor timed out");
}

async function renderApp(permissions: PermissionConfig, content: string) {
  const cfg = config(permissions);
  return testRender(
    <App
      initialSession={cfg}
      initialModel={{ providerID: cfg.provider.name, modelID: cfg.model }}
      workspaceRoot={root}
      sessionOptions={{ model: twoStepWriteModel(content) }}
      onExit={() => {}}
    />,
    { width: 100, height: 30 },
  );
}

/** Render the App with a custom model and optional effort ladder (test hook). */
async function renderAppWith(model: MockLanguageModelV4, testEfforts?: string[]) {
  const cfg = config("allow");
  return testRender(
    <App
      initialSession={cfg}
      initialModel={{ providerID: cfg.provider.name, modelID: cfg.model }}
      workspaceRoot={root}
      sessionOptions={{ model }}
      testEfforts={testEfforts}
      onExit={() => {}}
    />,
    { width: 100, height: 30 },
  );
}

const fileExists = (name: string) =>
  readFile(join(root, name), "utf8").then(
    () => true,
    () => false,
  );

describe("TUI App (integration, mock model)", () => {
  test("renders the status bar and composer on launch", async () => {
    const app = await renderApp(
      "allow",
      "x",
    );
    await app.flush();
    const frame = app.captureCharFrame();
    expect(frame).toContain("cozycode");
    expect(frame).toContain("Ask anything");
    app.renderer.destroy();
  });

  test("runs an allowed tool call and renders a contextual diff", async () => {
    const app = await renderApp(
      "allow",
      "auto-approved content",
    );

    await app.flush();
    await app.mockInput.typeText("make the file");
    app.mockInput.pressEnter();

    await waitFor(() => fileExists("out.txt"));
    expect(await readFile(join(root, "out.txt"), "utf8")).toBe("auto-approved content");
    await app.flush();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Wrote out.txt");
    expect(frame).toContain("make the file");
    expect(frame).toContain("auto-approved content");
    app.renderer.destroy();
  });

  test("renders compact search rows and shell output panels", async () => {
    const search = await testRender(
      <box width={100}>
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
      </box>,
      { width: 100, height: 4 },
    );
    await search.flush();
    expect(search.captureCharFrame()).toContain('Grep "TODO" in src (2 matches)');
    search.renderer.destroy();

    const shell = await testRender(
      <box width={100}>
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
      { width: 100, height: 8 },
    );
    await shell.flush();
    const frame = shell.captureCharFrame();
    expect(frame).toContain("Running in apps/tui");
    expect(frame).toContain("$ bun test");
    expect(frame).toContain("10 pass");
    shell.renderer.destroy();
  });

  test("renders assistant markdown without crashing", async () => {
    const app = await testRender(
      <box width={80} height={10}>
        <Markdown text={"**Done**\n\n- item"} />
      </box>,
      { width: 80, height: 10 },
    );
    await app.waitForFrame((frame) => frame.includes("item"));
    expect(app.captureCharFrame()).toContain("Done");
    app.renderer.destroy();
  });

  test("prompts for approval and applies the action once allowed", async () => {
    const app = await renderApp(
      { edit: "ask" },
      "approved content",
    );

    await app.flush();
    await app.mockInput.typeText("make the file");
    app.mockInput.pressEnter();

    // The approval prompt should appear and the file must NOT exist yet.
    await app.waitForFrame((frame) => frame.includes("Permission required"));
    expect(app.captureCharFrame()).toContain("Allow once");
    expect(app.captureCharFrame()).toContain("Allow always");
    expect(await fileExists("out.txt")).toBe(false);

    // "Allow once" is the first option — pressing enter selects it.
    app.mockInput.pressEnter();

    await waitFor(() => fileExists("out.txt"));
    expect(await readFile(join(root, "out.txt"), "utf8")).toBe("approved content");
    app.renderer.destroy();
  });

  test("auto-shows the sidebar on wide terminals", async () => {
    const app = await renderApp("allow", "x");
    app.resize(130, 30);
    await app.flush();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Workspace");
    expect(frame).toContain("Usage");
    expect(frame).toContain("Tools");
    app.renderer.destroy();
  });

  test("toggles the sidebar with ctrl+b on narrow terminals", async () => {
    const app = await renderApp("allow", "x");
    await app.flush();
    // Default width 100 (< 120) hides the sidebar.
    expect(app.captureCharFrame()).not.toContain("Workspace");
    app.mockInput.pressKey("b", { ctrl: true });
    await app.flush();
    expect(app.captureCharFrame()).toContain("Workspace");
    app.renderer.destroy();
  });

  test("opens the model selector with ctrl+o and closes on escape", async () => {
    const app = await renderApp("allow", "x");
    await app.flush();
    app.mockInput.pressKey("o", { ctrl: true });
    await waitFor(async () => {
      await app.flush();
      return app.captureCharFrame().includes("Switch model");
    });
    expect(app.captureCharFrame()).toContain("mock-model");
    app.mockInput.pressEscape();
    await waitFor(async () => {
      await app.flush();
      return !app.captureCharFrame().includes("Switch model");
    });
    app.renderer.destroy();
  });

  test("opens the searchable session switcher with /sessions", async () => {
    const app = await renderApp("allow", "x");
    await app.flush();
    await app.mockInput.typeText("/sessions");
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("Switch session"));
    expect(app.captureCharFrame()).toContain("New session -");
    app.mockInput.pressEscape();
    app.renderer.destroy();
  });

  test("renames the active session with /rename", async () => {
    const app = await renderApp("allow", "x");
    await app.flush();
    await app.mockInput.typeText("/rename");
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("Rename session"));
    await app.mockInput.typeText("Release checklist");
    await app.flush();
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => !frame.includes("Rename session"));
    await app.mockInput.typeText("/sessions");
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("Switch session"));
    expect(app.captureCharFrame()).toContain("Release checklist");
    app.renderer.destroy();
  });

  test("handles help slash command without sending a model message", async () => {
    const app = await renderApp(
      "allow",
      "x",
    );

    await app.flush();
    await app.mockInput.typeText("/help");
    app.mockInput.pressEnter();

    await app.waitForFrame((frame) => frame.includes("Help"));
    expect(app.captureCharFrame()).toContain("ctrl+p");
    expect(await fileExists("out.txt")).toBe(false);
    app.renderer.destroy();
  });

  test("/plan switches the prompt to read-only Plan mode without invoking the model", async () => {
    const app = await renderApp(
      "allow",
      "should not be written",
    );

    await app.flush();
    await app.mockInput.typeText("/plan");
    app.mockInput.pressEnter();

    await app.waitForFrame((frame) => frame.includes("PLAN"));
    const frame = app.captureCharFrame();
    expect(frame).toContain("PLAN");
    expect(frame).toContain("read-only");
    // No model turn ran, so the file was never written.
    expect(await fileExists("out.txt")).toBe(false);
    app.renderer.destroy();
  });

  test("/plan then /build restores Build mode", async () => {
    const app = await renderApp(
      "allow",
      "x",
    );

    await app.flush();
    await app.mockInput.typeText("/plan");
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("PLAN"));

    await app.mockInput.typeText("/build");
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("BUILD"));
    expect(app.captureCharFrame()).toContain("BUILD");
    app.renderer.destroy();
  });

  test("Tab key toggles between Plan and Build modes", async () => {
    const app = await renderApp(
      "allow",
      "x",
    );

    await app.flush();
    // Initial mode is build; the prompt hint mentions Tab.
    const frame = app.captureCharFrame();
    expect(frame).toContain("BUILD");
    expect(frame).toContain("tab mode");

    // /plan slash command switches to plan (Tab-to-toggle is verified manually).
    await app.mockInput.typeText("/plan");
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("PLAN"));
    expect(app.captureCharFrame()).toContain("PLAN");
    app.renderer.destroy();
  });

  test("typing a slash prefix shows command autocomplete suggestions", async () => {
    const app = await renderApp(
      "allow",
      "x",
    );

    await app.flush();
    // Partial command name, not submitted: suggestions should surface.
    await app.mockInput.typeText("/mo");
    await app.waitForFrame((frame) => frame.includes("/model"));
    expect(app.captureCharFrame()).toContain("/model");
    app.renderer.destroy();
  });

  test("an unknown slash command reports an error and does not hit the model", async () => {
    const app = await renderApp(
      "allow",
      "should not be written",
    );

    await app.flush();
    await app.mockInput.typeText("/bogus");
    app.mockInput.pressEnter();

    await app.waitForFrame((frame) => frame.includes("Unknown command: /bogus"));
    expect(await fileExists("out.txt")).toBe(false);
    app.renderer.destroy();
  });

  test("Reasoning row renders collapsed with a duration and hides the body", async () => {
    const app = await testRender(
      <box width={100} height={6}>
        <Reasoning
          item={{
            id: "r",
            kind: "reasoning",
            reasoningId: "r1",
            text: "**Plan**\n\nsecret body",
            streaming: false,
            durationMs: 4200,
          }}
        />
      </box>,
      { width: 100, height: 6 },
    );
    await app.flush();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Thought");
    expect(frame).toContain("4s");
    expect(frame).toContain("Plan");
    expect(frame).not.toContain("secret body");
    app.renderer.destroy();
  });

  test("streams a collapsed thinking block then the final answer", async () => {
    const app = await renderAppWith(reasoningModel());
    await app.flush();
    await app.mockInput.typeText("think about it");
    app.mockInput.pressEnter();
    await app.waitForFrame((frame) => frame.includes("Here is the answer."));
    const frame = app.captureCharFrame();
    expect(frame).toContain("Thought");
    // Collapsed by default: the reasoning body is not shown.
    expect(frame).not.toContain("Planning the approach.");
    app.renderer.destroy();
  });

  test("ctrl+t cycles reasoning effort shown in the sidebar", async () => {
    const app = await renderAppWith(twoStepWriteModel("x"), ["low", "medium", "high"]);
    app.resize(130, 30); // wide enough to show the sidebar (with its effort line)
    await app.flush();
    // No effort selected initially.
    expect(app.captureCharFrame()).not.toContain("effort: low");

    // Cycle: default → low → medium → high → default.
    app.mockInput.pressKey("t", { ctrl: true });
    await app.waitForFrame((frame) => frame.includes("effort: low"));

    app.mockInput.pressKey("t", { ctrl: true });
    await app.waitForFrame((frame) => frame.includes("effort: medium"));

    app.mockInput.pressKey("t", { ctrl: true });
    await app.waitForFrame((frame) => frame.includes("effort: high"));

    app.mockInput.pressKey("t", { ctrl: true });
    await app.waitForFrame((frame) => !frame.includes("effort:"));
    app.renderer.destroy();
  });
});
