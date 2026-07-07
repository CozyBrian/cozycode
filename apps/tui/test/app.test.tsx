import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { PermissionPolicy, SessionConfig } from "@cozycode/protocol";
import { App } from "../src/app.tsx";

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

function renderApp(policy: PermissionPolicy, content: string) {
  const cfg = config(policy);
  return render(
    <App
      config={cfg}
      model={cfg.model}
      workspaceRoot={root}
      sessionOptions={{ model: twoStepWriteModel(content) }}
    />,
  );
}

const fileExists = (name: string) =>
  readFile(join(root, name), "utf8").then(
    () => true,
    () => false,
  );

describe("TUI App (integration, mock model)", () => {
  test("renders the status bar and composer on launch", async () => {
    const { lastFrame, unmount } = renderApp(
      { defaultDecision: "allow", tools: {} },
      "x",
    );
    await sleep(50);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("cozycode");
    expect(frame).toContain("Describe a task");
    unmount();
  });

  test("runs an allowed tool call and streams the answer", async () => {
    const { lastFrame, stdin, unmount } = renderApp(
      { defaultDecision: "allow", tools: { write_file: "allow" } },
      "auto-approved content",
    );

    await sleep(50);
    stdin.write("make the file");
    await sleep(20);
    stdin.write("\r");

    await waitFor(() => fileExists("out.txt"));
    expect(await readFile(join(root, "out.txt"), "utf8")).toBe("auto-approved content");

    await waitFor(() => (lastFrame() ?? "").includes("Done writing."));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("write_file");
    expect(frame).toContain("make the file");
    unmount();
  });

  test("prompts for approval and applies the action once allowed", async () => {
    const { lastFrame, stdin, unmount } = renderApp(
      { defaultDecision: "ask", tools: { write_file: "ask" } },
      "approved content",
    );

    await sleep(50);
    stdin.write("make the file");
    await sleep(20);
    stdin.write("\r");

    // The approval prompt should appear and the file must NOT exist yet.
    await waitFor(() => (lastFrame() ?? "").includes("Approve action?"));
    expect(await fileExists("out.txt")).toBe(false);

    // "Allow once" is the first option — pressing enter selects it.
    stdin.write("\r");

    await waitFor(() => fileExists("out.txt"));
    expect(await readFile(join(root, "out.txt"), "utf8")).toBe("approved content");
    unmount();
  });
});
