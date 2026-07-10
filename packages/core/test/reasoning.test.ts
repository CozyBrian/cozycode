import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import type { ProviderConfig, SessionConfig, SessionEvent } from "@cozycode/protocol";
import {
  createSession,
  reasoningEfforts,
  reasoningProviderOptions,
} from "../src/index.ts";
import type { Session } from "../src/session.ts";

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as const;

describe("reasoningEfforts ladder", () => {
  test("non-reasoning models expose no ladder", () => {
    expect(reasoningEfforts("gpt-4o", { reasoning: false })).toEqual([]);
    expect(reasoningEfforts("gpt-4o", {})).toEqual([]);
  });

  test("always-on reasoning models (specific ids) expose no ladder", () => {
    expect(reasoningEfforts("deepseek-reasoner", { reasoning: true })).toEqual([]);
    expect(reasoningEfforts("deepseek-v3", { reasoning: true })).toEqual([]);
    expect(reasoningEfforts("glm-4.6", { reasoning: true })).toEqual([]);
    expect(reasoningEfforts("qwen-max", { reasoning: true })).toEqual([]);
    expect(reasoningEfforts("kimi-k2", { reasoning: true })).toEqual([]);
  });

  test("effort-capable reasoning models get the widely-supported ladder", () => {
    // deepseek-v4-* is NOT excluded (only chat/reasoner/r1/v3 are).
    expect(reasoningEfforts("deepseek-v4-pro", { reasoning: true })).toEqual(["low", "medium", "high"]);
    expect(reasoningEfforts("deepseek-v4-flash", { reasoning: true })).toEqual(["low", "medium", "high"]);
  });

  test("GLM 5.2 and grok-3-mini special cases", () => {
    expect(reasoningEfforts("glm-5.2", { reasoning: true })).toEqual(["high", "max"]);
    expect(reasoningEfforts("grok-3-mini", { reasoning: true })).toEqual(["low", "high"]);
    expect(reasoningEfforts("grok-4", { reasoning: true })).toEqual([]);
  });

  test("gpt-5 family ladders vary by version", () => {
    expect(reasoningEfforts("gpt-5", { reasoning: true })).toEqual(["minimal", "low", "medium", "high"]);
    expect(reasoningEfforts("gpt-5.1", { reasoning: true })).toEqual(["none", "low", "medium", "high"]);
    expect(reasoningEfforts("gpt-5.2", { reasoning: true })).toEqual(["none", "low", "medium", "high", "xhigh"]);
    expect(reasoningEfforts("gpt-5.4", { reasoning: true })).toEqual(["none", "low", "medium", "high", "xhigh"]);
  });

  test("gpt-5 pro / chat / codex special cases", () => {
    expect(reasoningEfforts("gpt-5-pro", { reasoning: true })).toEqual(["high"]);
    expect(reasoningEfforts("gpt-5.2-pro", { reasoning: true })).toEqual(["medium", "high", "xhigh"]);
    expect(reasoningEfforts("gpt-5-chat", { reasoning: true })).toEqual([]);
    expect(reasoningEfforts("gpt-5-codex", { reasoning: true })).toEqual(["low", "medium", "high"]);
    expect(reasoningEfforts("gpt-5-codex-max", { reasoning: true })).toEqual(["low", "medium", "high", "xhigh"]);
    expect(reasoningEfforts("gpt-5.3-codex-spark", { reasoning: true })).toEqual([
      "none", "low", "medium", "high", "xhigh",
    ]);
  });

  test("provider-prefixed ids are stripped before matching", () => {
    expect(reasoningEfforts("openai/gpt-5.2", { reasoning: true })).toEqual([
      "none", "low", "medium", "high", "xhigh",
    ]);
  });

  test("other reasoning models get the widely-supported ladder", () => {
    expect(reasoningEfforts("o3", { reasoning: true })).toEqual(["low", "medium", "high"]);
    expect(reasoningEfforts("o4-mini", { reasoning: true })).toEqual(["low", "medium", "high"]);
  });
});

describe("reasoningProviderOptions", () => {
  const openai: ProviderConfig = { name: "openai", kind: "openai", baseURL: "x" };
  const oauth: ProviderConfig = { name: "openai", kind: "openai-oauth", baseURL: "x" };
  const compat: ProviderConfig = { name: "local", baseURL: "x" };

  test("undefined effort yields no options", () => {
    expect(reasoningProviderOptions(openai, undefined)).toBeUndefined();
    expect(reasoningProviderOptions(compat, "")).toBeUndefined();
  });

  test("openai / openai-oauth use the responses reasoning bag", () => {
    for (const provider of [openai, oauth]) {
      expect(reasoningProviderOptions(provider, "high")).toEqual({
        openai: {
          reasoningEffort: "high",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      });
    }
  });

  test("openai-compatible uses reasoningEffort", () => {
    expect(reasoningProviderOptions(compat, "medium")).toEqual({
      openaiCompatible: { reasoningEffort: "medium" },
    });
  });
});

// --- session integration -----------------------------------------------------

function step(parts: LanguageModelV4StreamPart[]) {
  return { stream: simulateReadableStream({ chunks: parts }) };
}

/** A model that records the providerOptions it was called with. */
function captureOptionsModel(captured: Array<unknown>) {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      captured.push(options.providerOptions);
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

/** A model that emits a reasoning block before its text. */
function reasoningModel() {
  return new MockLanguageModelV4({
    doStream: step([
      { type: "stream-start", warnings: [] },
      { type: "reasoning-start", id: "r1" },
      { type: "reasoning-delta", id: "r1", delta: "Think " },
      { type: "reasoning-delta", id: "r1", delta: "harder." },
      { type: "reasoning-end", id: "r1" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "answer" },
      { type: "text-end", id: "t1" },
      { type: "finish", finishReason: "stop", usage },
    ]),
  });
}

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-reasoning-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function config(provider: ProviderConfig, reasoningEffort?: string): SessionConfig {
  return { provider, model: "mock-model", workspaceRoot: root, reasoningEffort };
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

describe("session reasoning wiring", () => {
  test("initial effort threads openai providerOptions into the request", async () => {
    const captured: unknown[] = [];
    const session = createSession(
      config({ name: "openai", kind: "openai", baseURL: "x" }, "high"),
      { model: captureOptionsModel(captured) },
    );
    await runTurn(session, "hi");
    session.close();
    expect(captured[0]).toEqual({
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    });
  });

  test("openai-compatible provider maps to reasoningEffort", async () => {
    const captured: unknown[] = [];
    const session = createSession(config({ name: "local", baseURL: "x" }, "medium"), {
      model: captureOptionsModel(captured),
    });
    await runTurn(session, "hi");
    session.close();
    expect(captured[0]).toEqual({ openaiCompatible: { reasoningEffort: "medium" } });
  });

  test("clearing the effort removes providerOptions and emits effort-change", async () => {
    const captured: unknown[] = [];
    const session = createSession(
      config({ name: "openai", kind: "openai", baseURL: "x" }, "high"),
      { model: captureOptionsModel(captured) },
    );
    const events: SessionEvent[] = [];
    const collect = (async () => {
      for await (const e of session.events) events.push(e);
    })();
    await session.send("one");
    session.setReasoningEffort(undefined);
    await session.send("two");
    session.close();
    await collect;
    expect(captured[0]).toBeDefined();
    expect(captured[1]).toBeUndefined();
    expect(events.some((e) => e.type === "effort-change" && e.effort === undefined)).toBe(true);
  });

  test("reasoning stream parts surface as ordered reasoning events with a duration", async () => {
    const session = createSession(config({ name: "local", baseURL: "x" }), {
      model: reasoningModel(),
    });
    const events = await runTurn(session, "hi");
    session.close();
    const reasoning = events.filter((e) => e.type.startsWith("reasoning-"));
    expect(reasoning.map((e) => e.type)).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-delta",
      "reasoning-end",
    ]);
    const text = reasoning
      .filter((e): e is Extract<SessionEvent, { type: "reasoning-delta" }> => e.type === "reasoning-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("Think harder.");
    const end = reasoning.find((e) => e.type === "reasoning-end") as
      | Extract<SessionEvent, { type: "reasoning-end" }>
      | undefined;
    expect(typeof end?.durationMs).toBe("number");
  });
});
