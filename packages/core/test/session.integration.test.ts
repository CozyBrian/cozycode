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
import {
  BUILD_SWITCH_REMINDER,
  PLAN_MODE_DENIAL_MESSAGE,
  PLAN_MODE_REMINDER,
  createSession,
} from "../src/index.ts";

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

function twoStepShellModel(command: string) {
  return new MockLanguageModelV4({
    doStream: [
      step([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "run_shell",
          input: JSON.stringify({ command }),
        },
        { type: "finish", finishReason: "tool-calls", usage },
      ]),
      step([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Done." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage },
      ]),
    ],
  });
}

function capturePromptModel(prompts: unknown[]) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(options.prompt);
      return step([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "ok" },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage },
      ]);
    },
  });
}

function promptText(prompts: unknown[], index = prompts.length - 1): string {
  return collectStrings(prompts[index]);
}

function latestUserText(prompts: unknown[], index = prompts.length - 1): string {
  const prompt = prompts[index];
  if (!Array.isArray(prompt)) return promptText(prompts, index);
  const userMessages = prompt.filter(
    (message): message is { role: string; content: unknown } =>
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "user" &&
      "content" in message,
  );
  return collectStrings(userMessages.at(-1)?.content);
}

function collectStrings(value: unknown): string {
  const strings: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      strings.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(value);
  return strings.join("\n");
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
    expect(
      result &&
        "result" in result &&
        (result.result as { message?: string }).message,
    ).toBe(PLAN_MODE_DENIAL_MESSAGE);

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

  test("plan send injects the plan-mode reminder into the model prompt", async () => {
    const prompts: unknown[] = [];
    const session = createSession(
      config({ defaultDecision: "allow", tools: {} }, "plan"),
      async () => "allow-once",
      { model: capturePromptModel(prompts) },
    );

    const done = collect(session.events, "finish");
    await session.send("inspect this change");
    await done;

    expect(promptText(prompts)).toContain("inspect this change");
    expect(promptText(prompts)).toContain(PLAN_MODE_REMINDER);
  });

  test("first build send after a plan turn injects the build-switch reminder once", async () => {
    const prompts: unknown[] = [];
    const session = createSession(
      config({ defaultDecision: "allow", tools: {} }),
      async () => "allow-once",
      { model: capturePromptModel(prompts) },
    );

    session.setMode("plan");
    let done = collect(session.events, "finish");
    await session.send("make a plan");
    await done;

    session.setMode("build");
    done = collect(session.events, "finish");
    await session.send("go ahead");
    await done;
    done = collect(session.events, "finish");
    await session.send("continue");
    await done;

    expect(latestUserText(prompts, 1)).toContain(BUILD_SWITCH_REMINDER);
    expect(latestUserText(prompts, 2)).not.toContain(BUILD_SWITCH_REMINDER);
  });

  test("plan to build with no plan send does not inject the build-switch reminder", async () => {
    const prompts: unknown[] = [];
    const session = createSession(
      config({ defaultDecision: "allow", tools: {} }),
      async () => "allow-once",
      { model: capturePromptModel(prompts) },
    );

    session.setMode("plan");
    session.setMode("build");
    const done = collect(session.events, "finish");
    await session.send("start now");
    await done;

    expect(promptText(prompts)).not.toContain(BUILD_SWITCH_REMINDER);
  });

  test("plain build send has no mode reminders", async () => {
    const prompts: unknown[] = [];
    const session = createSession(
      config({ defaultDecision: "allow", tools: {} }),
      async () => "allow-once",
      { model: capturePromptModel(prompts) },
    );

    const done = collect(session.events, "finish");
    await session.send("build normally");
    await done;

    expect(promptText(prompts)).not.toContain(PLAN_MODE_REMINDER);
    expect(promptText(prompts)).not.toContain(BUILD_SWITCH_REMINDER);
  });

  test("unknown shell command in plan mode under ask policy invokes approval", async () => {
    let asked = false;
    const session = createSession(
      config({ defaultDecision: "ask", tools: { run_shell: "ask" } }, "plan"),
      async () => {
        asked = true;
        return "deny";
      },
      { model: twoStepShellModel("bun run build") },
    );

    const done = collect(session.events, "finish");
    await session.send("try a shell command");
    await done;

    expect(asked).toBe(true);
  });
});
