import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type {
  AgentMode,
  ApprovalOutcome,
  PermissionPolicy,
  SessionConfig,
  SessionEvent,
} from "@cozycode/protocol";
import { createSession } from "../src/index.ts";

/**
 * End-to-end coverage of the Session pipeline (model -> tool loop -> permission
 * gate -> event stream) with a mock model, so the full wiring is exercised
 * offline without a network endpoint.
 */

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 } as const;

function step(parts: LanguageModelV4StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts }) };
}

/** A model that calls write_file, then (next step) emits a final message. */
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
        { type: "text-delta", id: "t1", delta: "Done. " },
        { type: "text-delta", id: "t1", delta: "Wrote the file." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage },
      ]),
    ],
  });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-session-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(policy: PermissionPolicy, mode?: AgentMode): SessionConfig {
  return {
    provider: { name: "mock", baseURL: "http://localhost/v1" },
    model: "mock-model",
    workspaceRoot: root,
    permissions: policy,
    ...(mode ? { mode } : {}),
  };
}

async function collect(events: AsyncIterable<SessionEvent>, until: SessionEvent["type"]) {
  const out: SessionEvent[] = [];
  for await (const e of events) {
    out.push(e);
    if (e.type === until) break;
  }
  return out;
}

describe("Session (integration, mock model)", () => {
  test("runs a tool call, gates it, applies it, and streams the answer", async () => {
    const approvals: string[] = [];
    const handler = async (): Promise<ApprovalOutcome> => {
      approvals.push("asked");
      return "allow-once";
    };

    const session = createSession(
      config({ defaultDecision: "ask", tools: { write_file: "ask" } }),
      handler,
      { model: twoStepWriteModel("hello from the agent") },
    );

    const done = collect(session.events, "finish");
    await session.send("create out.txt");
    const events = await done;

    // The write was approved (policy was "ask").
    expect(approvals).toEqual(["asked"]);

    // Event stream carries the tool call, its approval, its result, and text.
    const types = events.map((e) => e.type);
    expect(types).toContain("tool-call-start");
    expect(types).toContain("tool-approval");
    expect(types).toContain("tool-result");

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult && "isError" in toolResult && toolResult.isError).toBe(false);

    const text = events
      .filter((e): e is Extract<SessionEvent, { type: "text-delta" }> => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Done. Wrote the file.");

    // The side effect actually landed on disk.
    expect(await readFile(join(root, "out.txt"), "utf8")).toBe("hello from the agent");
  });

  test("a denied tool call blocks the side effect", async () => {
    const session = createSession(
      config({ defaultDecision: "ask", tools: { write_file: "deny" } }),
      async () => "deny",
      { model: twoStepWriteModel("should not be written") },
    );

    const done = collect(session.events, "finish");
    await session.send("create out.txt");
    const events = await done;

    const approval = events.find((e) => e.type === "tool-approval");
    expect(approval && "decision" in approval && approval.decision).toBe("deny");

    // File must NOT exist — the gate blocked the write.
    let existed = true;
    await readFile(join(root, "out.txt"), "utf8").catch(() => (existed = false));
    expect(existed).toBe(false);
  });

  test("plan mode blocks write_file even when policy allows it", async () => {
    const session = createSession(
      config({ defaultDecision: "allow", tools: { write_file: "allow" } }, "plan"),
      async () => "allow-once",
      { model: twoStepWriteModel("should not be written") },
    );

    const done = collect(session.events, "finish");
    await session.send("create out.txt");
    const events = await done;

    // The window starts in plan mode per the config.
    expect(session.mode).toBe("plan");

    const approval = events.find((e) => e.type === "tool-approval");
    expect(approval && "decision" in approval && approval.decision).toBe("deny");
    const result = events.find((e) => e.type === "tool-result");
    expect(result && "isError" in result && result.isError).toBe(false);
    expect(
      result && "result" in result && (result.result as { denied?: boolean }).denied,
    ).toBe(true);

    let existed = true;
    await readFile(join(root, "out.txt"), "utf8").catch(() => (existed = false));
    expect(existed).toBe(false);
  });

  test("setMode(plan) emits a mode-change event and blocks writes", async () => {
    const session = createSession(
      config({ defaultDecision: "allow", tools: { write_file: "allow" } }),
      async () => "allow-once",
      { model: twoStepWriteModel("should not be written") },
    );

    expect(session.mode).toBe("build");
    session.setMode("plan");
    expect(session.mode).toBe("plan");

    const done = collect(session.events, "finish");
    await session.send("create out.txt");
    const events = await done;

    // mode-change event was pushed before the turn's events.
    const modeEvent = events.find((e) => e.type === "mode-change");
    expect(modeEvent && "mode" in modeEvent && modeEvent.mode).toBe("plan");

    const approval = events.find((e) => e.type === "tool-approval");
    expect(approval && "decision" in approval && approval.decision).toBe("deny");

    let existed = true;
    await readFile(join(root, "out.txt"), "utf8").catch(() => (existed = false));
    expect(existed).toBe(false);
  });

  test("entering plan mode sets a plan file path and creates the directory", async () => {
    const session = createSession(
      config({ defaultDecision: "allow", tools: {} }),
      async () => "allow-once",
    );

    session.setMode("plan");
    const planFile = session.planFile;
    expect(planFile).toBeTruthy();
    expect(planFile!.startsWith(".cozycode/plans/")).toBe(true);
    expect(planFile!.endsWith(".md")).toBe(true);

    // The plan file directory should exist.
    const { stat } = await import("node:fs/promises");
    const dirInfo = await stat(join(root, ".cozycode/plans"));
    expect(dirInfo.isDirectory()).toBe(true);
  });

  test("plan -> build preserves planFile path for build-agent instructions", async () => {
    const session = createSession(
      config({ defaultDecision: "allow", tools: {} }),
      async () => "allow-once",
    );

    session.setMode("plan");
    const planFile = session.planFile;
    expect(planFile).toBeTruthy();

    session.setMode("build");
    // planFile is retained so buildAgent can reference it in instructions.
    expect(session.mode).toBe("build");
    expect(session.planFile).toBe(planFile);
  });});
