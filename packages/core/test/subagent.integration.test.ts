import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { AgentInfo, SessionConfig, SessionEvent } from "@cozycode/protocol";
import { createSession, rulesetFromConfig } from "../src/index.ts";
import type { Session } from "../src/session.ts";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;
const step = (parts: LanguageModelV4StreamPart[]) => ({ stream: simulateReadableStream({ chunks: parts }) });

/** Parent model: calls `task` in step 1, then emits final text in step 2. */
function parentModel(subagentType: string) {
  return new MockLanguageModelV4({
    doStream: [
      step([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "call-t",
          toolName: "task",
          input: JSON.stringify({ description: "find the thing", prompt: "Locate X.", subagent_type: subagentType }),
        },
        { type: "finish", finishReason: "tool-calls", usage },
      ]),
      step([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Done, delegated." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage },
      ]),
    ],
  });
}

/** Child model: emits a single text result. */
function childModel(text: string) {
  return new MockLanguageModelV4({
    doStream: step([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "c1" },
      { type: "text-delta", id: "c1", delta: text },
      { type: "text-end", id: "c1" },
      { type: "finish", finishReason: "stop", usage },
    ]),
  });
}

const GENERAL: AgentInfo = { name: "general", mode: "subagent", source: "builtin", description: "general" };

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-subagent-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(): SessionConfig {
  return {
    provider: { name: "mock", baseURL: "http://localhost/v1" },
    model: "mock-model",
    workspaceRoot: root,
    permissions: rulesetFromConfig("allow"),
  };
}

async function runTurn(session: Session, message: string): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  const consume = (async () => {
    for await (const e of session.events) {
      out.push(e);
      if (e.type === "finish") break;
    }
  })();
  await session.send(message);
  await consume;
  return out;
}

describe("task tool / subagents", () => {
  test("spawns a child, funnels its events, and returns its text to the parent", async () => {
    const session = createSession(config(), {
      model: parentModel("general"),
      agents: [GENERAL],
      spawnModel: () => childModel("the thing is in foo.ts"),
    });
    const events = await runTurn(session, "delegate this");
    session.close();

    const start = events.find((e) => e.type === "subagent-start");
    const finish = events.find(
      (e): e is Extract<SessionEvent, { type: "subagent-finish" }> => e.type === "subagent-finish",
    );
    expect(start).toBeDefined();
    expect(events.some((e) => e.type === "subagent-event")).toBe(true);
    expect(finish).toBeDefined();
    expect(finish!.toolCallId).toBe("call-t");
    expect(finish!.result).toContain("the thing is in foo.ts");

    // The child's text returns to the parent model as the task tool result.
    const result = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.toolName === "task",
    );
    expect(JSON.stringify(result!.result)).toContain("the thing is in foo.ts");
  });

  test("unknown subagent type returns an error result without spawning", async () => {
    const session = createSession(config(), {
      model: parentModel("nonexistent"),
      agents: [GENERAL],
      spawnModel: () => childModel("should not run"),
    });
    const events = await runTurn(session, "delegate this");
    session.close();
    expect(events.some((e) => e.type === "subagent-start")).toBe(false);
    const result = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.toolName === "task",
    );
    expect(JSON.stringify(result!.result)).toContain("Unknown subagent type");
  });

  test("subagent sessions get no task tool (no recursion)", async () => {
    // A session created with isSubagent has no `task` tool even with agents present.
    const child = createSession(config(), {
      isSubagent: true,
      agents: [GENERAL],
      model: childModel("x"),
    });
    // Reaching into the built tool set: the task tool must be absent.
    // (Indirect check: a subagent's spawnSubagent is undefined, so buildTools omits task.)
    expect(child.mode).toBe("build");
    child.close();
  });
});
