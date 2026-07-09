import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type {
  AgentMode,
  PermissionConfig,
  PermissionReply,
  SessionConfig,
  SessionEvent,
} from "@cozycode/protocol";
import {
  BUILD_SWITCH_REMINDER,
  PLAN_MODE_DENIAL_MESSAGE,
  PLAN_MODE_REMINDER,
  createSession,
  rulesetFromConfig,
} from "../src/index.ts";
import type { Session } from "../src/session.ts";

/**
 * End-to-end coverage of the Session pipeline (model -> tool loop -> permission
 * service -> event stream) with a mock model, so the full wiring is exercised
 * offline without a network endpoint. Approvals are answered by consuming the
 * event stream and calling `session.replyPermission`, matching how frontends work.
 *
 * NOTE: the plan-mode cases here can be flaky under full-suite load (a known,
 * pre-existing timing issue, not a regression in the permission rewrite).
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

function config(permissions: PermissionConfig, mode?: AgentMode): SessionConfig {
  return {
    provider: { name: "mock", baseURL: "http://localhost/v1" },
    model: "mock-model",
    workspaceRoot: root,
    permissions: rulesetFromConfig(permissions),
    ...(mode ? { mode } : {}),
  };
}

/**
 * Drive one turn, collecting events until `finish`. Any permission ask is
 * answered with `reply` (default: reject). Returns the collected events.
 */
async function runTurn(
  session: Session,
  message: string,
  reply: PermissionReply = "reject",
): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  const consume = (async () => {
    for await (const e of session.events) {
      out.push(e);
      if (e.type === "permission-asked") session.replyPermission(e.request.id, reply);
      if (e.type === "finish") break;
    }
  })();
  await session.send(message);
  await consume;
  return out;
}

describe("Session (integration, mock model)", () => {
  test("runs a tool call, gates it, applies it, and streams the answer", async () => {
    const session = createSession(config({ edit: "ask" }), {
      model: twoStepWriteModel("hello from the agent"),
    });

    const events = await runTurn(session, "create out.txt", "once");

    const types = events.map((e) => e.type);
    expect(types).toContain("permission-asked");
    expect(types).toContain("permission-replied");
    expect(types).toContain("tool-call-start");
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

  test("a deny rule blocks the side effect without asking", async () => {
    const session = createSession(config({ edit: "deny" }), {
      model: twoStepWriteModel("should not be written"),
    });

    const events = await runTurn(session, "create out.txt");

    // Denied by rule → no ask surfaced.
    expect(events.some((e) => e.type === "permission-asked")).toBe(false);

    const result = events.find((e) => e.type === "tool-result");
    expect(result && "result" in result && (result.result as { denied?: boolean }).denied).toBe(
      true,
    );

    let existed = true;
    await readFile(join(root, "out.txt"), "utf8").catch(() => (existed = false));
    expect(existed).toBe(false);
  });

  test("a rejected ask returns the rejection message to the model", async () => {
    const session = createSession(config({ edit: "ask" }), {
      model: twoStepWriteModel("should not be written"),
    });

    const events = await runTurn(session, "create out.txt", "reject");

    const result = events.find((e) => e.type === "tool-result");
    const message =
      result && "result" in result ? (result.result as { message?: string }).message : "";
    expect(message).toContain("rejected");

    let existed = true;
    await readFile(join(root, "out.txt"), "utf8").catch(() => (existed = false));
    expect(existed).toBe(false);
  });

  test("plan mode blocks write_file even when the base allows it", async () => {
    const session = createSession(config("allow", "plan"), {
      model: twoStepWriteModel("should not be written"),
    });

    const events = await runTurn(session, "create out.txt");
    expect(session.mode).toBe("plan");

    const result = events.find((e) => e.type === "tool-result");
    expect(result && "result" in result && (result.result as { denied?: boolean }).denied).toBe(
      true,
    );
    expect(
      result && "result" in result && (result.result as { message?: string }).message,
    ).toBe(PLAN_MODE_DENIAL_MESSAGE);

    let existed = true;
    await readFile(join(root, "out.txt"), "utf8").catch(() => (existed = false));
    expect(existed).toBe(false);
  });

  test("setMode(plan) emits a mode-change event and blocks writes", async () => {
    const session = createSession(config("allow"), {
      model: twoStepWriteModel("should not be written"),
    });

    expect(session.mode).toBe("build");
    session.setMode("plan");
    expect(session.mode).toBe("plan");

    const events = await runTurn(session, "create out.txt");

    const modeEvent = events.find((e) => e.type === "mode-change");
    expect(modeEvent && "mode" in modeEvent && modeEvent.mode).toBe("plan");

    const result = events.find((e) => e.type === "tool-result");
    expect(result && "result" in result && (result.result as { denied?: boolean }).denied).toBe(
      true,
    );

    let existed = true;
    await readFile(join(root, "out.txt"), "utf8").catch(() => (existed = false));
    expect(existed).toBe(false);
  });

  test("plan send injects the plan-mode reminder into the model prompt", async () => {
    const prompts: unknown[] = [];
    const session = createSession(config("allow", "plan"), {
      model: capturePromptModel(prompts),
    });

    await runTurn(session, "inspect this change");

    expect(promptText(prompts)).toContain("inspect this change");
    expect(promptText(prompts)).toContain(PLAN_MODE_REMINDER);
  });

  test("first build send after a plan turn injects the build-switch reminder once", async () => {
    const prompts: unknown[] = [];
    const session = createSession(config("allow"), { model: capturePromptModel(prompts) });

    session.setMode("plan");
    await runTurn(session, "make a plan");
    session.setMode("build");
    await runTurn(session, "go ahead");
    await runTurn(session, "continue");

    expect(latestUserText(prompts, 1)).toContain(BUILD_SWITCH_REMINDER);
    expect(latestUserText(prompts, 2)).not.toContain(BUILD_SWITCH_REMINDER);
  });

  test("plan to build with no plan send does not inject the build-switch reminder", async () => {
    const prompts: unknown[] = [];
    const session = createSession(config("allow"), { model: capturePromptModel(prompts) });

    session.setMode("plan");
    session.setMode("build");
    await runTurn(session, "start now");

    expect(promptText(prompts)).not.toContain(BUILD_SWITCH_REMINDER);
  });

  test("plain build send has no mode reminders", async () => {
    const prompts: unknown[] = [];
    const session = createSession(config("allow"), { model: capturePromptModel(prompts) });

    await runTurn(session, "build normally");

    expect(promptText(prompts)).not.toContain(PLAN_MODE_REMINDER);
    expect(promptText(prompts)).not.toContain(BUILD_SWITCH_REMINDER);
  });

  test("unknown shell command in plan mode under ask policy invokes approval", async () => {
    const session = createSession(config({ bash: "ask" }, "plan"), {
      model: twoStepShellModel("bun run build"),
    });

    const events = await runTurn(session, "try a shell command", "reject");
    expect(events.some((e) => e.type === "permission-asked")).toBe(true);
  });
});
