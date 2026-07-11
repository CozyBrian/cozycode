import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { defaultSessionTitle, generateSessionTitle } from "../src/index.ts";

const generated = (text: string) => new MockLanguageModelV4({
  doGenerate: {
    content: [{ type: "text", text }],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    warnings: [],
    response: { headers: undefined },
  },
});

describe("session titles", () => {
  test("uses the next model when an earlier title model fails", async () => {
    const failed = new MockLanguageModelV4();
    await expect(generateSessionTitle([failed, generated("Project setup")], "Set up the project")).resolves.toBe("Project setup");
  });

  test("normalizes reasoning output and caps titles", async () => {
    const long = "x".repeat(120);
    await expect(generateSessionTitle([generated(`<think>ignore</think>\n${long}`)], "Prompt"))
      .resolves.toBe(`${"x".repeat(97)}...`);
  });

  test("uses the timestamp placeholder when no title model succeeds", async () => {
    expect(await generateSessionTitle([], "Prompt")).toBeUndefined();
    expect(defaultSessionTitle(new Date("2026-07-11T12:00:00.000Z")))
      .toBe("New session - 2026-07-11T12:00:00.000Z");
  });
});
