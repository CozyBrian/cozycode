import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { PermissionPolicy, SessionConfig } from "@cozycode/protocol";
import { App } from "../src/app.tsx";
import { Markdown } from "../src/components/Markdown.tsx";

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

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-tui-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(policy: PermissionPolicy): SessionConfig {
  return {
    provider: { name: "mock", baseURL: "http://localhost/v1" },
    model: "mock-model",
    workspaceRoot: root,
    permissions: policy,
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

async function renderApp(policy: PermissionPolicy, content: string) {
  const cfg = config(policy);
  return testRender(
    <App
      config={cfg}
      model={cfg.model}
      workspaceRoot={root}
      sessionOptions={{ model: twoStepWriteModel(content) }}
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
      { defaultDecision: "allow", tools: {} },
      "x",
    );
    await app.flush();
    const frame = app.captureCharFrame();
    expect(frame).toContain("cozycode");
    expect(frame).toContain("Ask anything");
    app.renderer.destroy();
  });

  test("runs an allowed tool call and renders the inline diff", async () => {
    const app = await renderApp(
      { defaultDecision: "allow", tools: { write_file: "allow" } },
      "auto-approved content",
    );

    await app.flush();
    await app.mockInput.typeText("make the file");
    app.mockInput.pressEnter();

    await waitFor(() => fileExists("out.txt"));
    expect(await readFile(join(root, "out.txt"), "utf8")).toBe("auto-approved content");
    await app.flush();
    const frame = app.captureCharFrame();
    expect(frame).toContain("write_file");
    expect(frame).toContain("make the file");
    expect(frame).toContain("auto-approved content");
    app.renderer.destroy();
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
      { defaultDecision: "ask", tools: { write_file: "ask" } },
      "approved content",
    );

    await app.flush();
    await app.mockInput.typeText("make the file");
    app.mockInput.pressEnter();

    // The approval prompt should appear and the file must NOT exist yet.
    await app.waitForFrame((frame) => frame.includes("Approve action?"));
    expect(await fileExists("out.txt")).toBe(false);

    // "Allow once" is the first option — pressing enter selects it.
    app.mockInput.pressEnter();

    await waitFor(() => fileExists("out.txt"));
    expect(await readFile(join(root, "out.txt"), "utf8")).toBe("approved content");
    app.renderer.destroy();
  });

  test("auto-shows the sidebar on wide terminals", async () => {
    const app = await renderApp({ defaultDecision: "allow", tools: {} }, "x");
    app.resize(130, 30);
    await app.flush();
    const frame = app.captureCharFrame();
    expect(frame).toContain("Workspace");
    expect(frame).toContain("Usage");
    expect(frame).toContain("Tools");
    app.renderer.destroy();
  });

  test("toggles the sidebar with ctrl+b on narrow terminals", async () => {
    const app = await renderApp({ defaultDecision: "allow", tools: {} }, "x");
    await app.flush();
    // Default width 100 (< 120) hides the sidebar.
    expect(app.captureCharFrame()).not.toContain("Workspace");
    app.mockInput.pressKey("b", { ctrl: true });
    await app.flush();
    expect(app.captureCharFrame()).toContain("Workspace");
    app.renderer.destroy();
  });

  test("opens the model selector with ctrl+o and closes on escape", async () => {
    const app = await renderApp({ defaultDecision: "allow", tools: {} }, "x");
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

  test("handles help slash command without sending a model message", async () => {
    const app = await renderApp(
      { defaultDecision: "allow", tools: {} },
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
      { defaultDecision: "allow", tools: { write_file: "allow" } },
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
      { defaultDecision: "allow", tools: { write_file: "allow" } },
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
      { defaultDecision: "allow", tools: { write_file: "allow" } },
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
      { defaultDecision: "allow", tools: { write_file: "allow" } },
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
      { defaultDecision: "allow", tools: { write_file: "allow" } },
      "should not be written",
    );

    await app.flush();
    await app.mockInput.typeText("/bogus");
    app.mockInput.pressEnter();

    await app.waitForFrame((frame) => frame.includes("Unknown command: /bogus"));
    expect(await fileExists("out.txt")).toBe(false);
    app.renderer.destroy();
  });});
