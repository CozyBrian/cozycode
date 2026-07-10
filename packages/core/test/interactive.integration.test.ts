import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { SessionConfig, SessionEvent } from "@cozycode/protocol";
import { createSession, rulesetFromConfig } from "../src/index.ts";
import type { Session } from "../src/session.ts";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;
const step = (parts: LanguageModelV4StreamPart[]) => ({ stream: simulateReadableStream({ chunks: parts }) });

/** Model that calls ask_user in step 1, then emits final text in step 2. */
function askUserModel() {
  return new MockLanguageModelV4({
    doStream: [
      step([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "call-q",
          toolName: "ask_user",
          input: JSON.stringify({
            questions: [
              { question: "Which database?", header: "DB", options: [{ label: "Postgres" }, { label: "MySQL" }] },
            ],
          }),
        },
        { type: "finish", finishReason: "tool-calls", usage },
      ]),
      step([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Using Postgres." },
        { type: "text-end", id: "t1" },
        { type: "finish", finishReason: "stop", usage },
      ]),
    ],
  });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-ask-"));
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

/** Drive one turn, answering the first question with `answer` (or rejecting). */
async function runTurn(
  session: Session,
  message: string,
  answer: string[][] | null,
): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  const consume = (async () => {
    for await (const e of session.events) {
      out.push(e);
      if (e.type === "question-asked") {
        if (answer === null) session.rejectQuestion(e.request.id);
        else session.answerQuestion(e.request.id, answer);
      }
      if (e.type === "finish") break;
    }
  })();
  await session.send(message);
  await consume;
  return out;
}

describe("ask_user tool integration", () => {
  test("answer reaches the model as the tool result, bypassing permissions", async () => {
    const session = createSession(config(), { model: askUserModel() });
    const events = await runTurn(session, "set up the db", [["Postgres"]]);
    session.close();

    expect(events.some((e) => e.type === "question-asked")).toBe(true);
    expect(events.some((e) => e.type === "question-answered")).toBe(true);
    // ask_user is interactive → it must NOT go through the permission gate.
    expect(events.some((e) => e.type === "permission-asked")).toBe(false);

    const result = events.find(
      (e): e is Extract<SessionEvent, { type: "tool-result" }> =>
        e.type === "tool-result" && e.toolName === "ask_user",
    );
    expect(result).toBeDefined();
    expect(JSON.stringify(result!.result)).toContain("Postgres");
    expect(result!.metadata?.answers).toEqual([["Postgres"]]);
  });

  test("aborting a pending question yields a terminal tool-result (no hang)", async () => {
    const session = createSession(config(), { model: askUserModel() });
    const out: SessionEvent[] = [];
    const consume = (async () => {
      for await (const e of session.events) {
        out.push(e);
        if (e.type === "question-asked") session.abort();
        if (e.type === "finish") break;
      }
    })();
    await session.send("set up the db");
    await consume;
    session.close();
    // The turn ended and the ask_user call produced a terminal result rather than hanging.
    expect(out.some((e) => e.type === "question-rejected")).toBe(true);
    expect(out.some((e) => e.type === "tool-result" && e.toolName === "ask_user")).toBe(true);
  });
});
