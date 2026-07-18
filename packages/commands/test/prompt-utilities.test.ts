import { describe, expect, test } from "bun:test";
import {
  detectCommandTrigger,
  detectFileReferenceTrigger,
  detectPromptTrigger,
  detectShellTrigger,
  rankFileReferences,
  rankSlashCommands,
  replacePromptTrigger,
} from "../src/index.ts";

describe("prompt triggers", () => {
  test("detects a slash command only in the leading token", () => {
    expect(detectCommandTrigger("/mod")).toEqual({ kind: "command", query: "mod", start: 0, end: 4 });
    expect(detectCommandTrigger(" /mod")).toBeUndefined();
    expect(detectCommandTrigger("/model open")).toBeUndefined();
    expect(detectCommandTrigger("/model later", 4)?.query).toBe("mod");
  });

  test("detects shell mode from the first character", () => {
    expect(detectShellTrigger("!git status")?.query).toBe("git status");
    expect(detectShellTrigger(" !git status")).toBeUndefined();
  });

  test("detects boundary-safe file references and ignores email-like text", () => {
    expect(detectFileReferenceTrigger("look at @src/app")?.query).toBe("src/app");
    expect(detectFileReferenceTrigger("@")?.query).toBe("");
    expect(detectFileReferenceTrigger("mail a@b.com")).toBeUndefined();
    expect(detectFileReferenceTrigger("@src file")).toBeUndefined();
  });

  test("file completion wins inside shell text and replacement preserves the suffix", () => {
    const trigger = detectPromptTrigger("!cat @src/ap now", 12);
    expect(trigger?.kind).toBe("file");
    expect(replacePromptTrigger("!cat @src/ap now", trigger!, "src/app.ts")).toEqual({
      text: "!cat @src/app.ts now",
      cursor: 16,
    });
  });
});

describe("safe fuzzy ranking", () => {
  const commands = [
    { name: "model", description: "Switch model", aliases: ["m"] },
    { name: "provider", description: "Connect a provider" },
    { name: "sessions", description: "Switch session" },
    { name: "secret", hidden: true },
  ];

  test("ranks exact, prefix, alias, and description command matches", () => {
    expect(rankSlashCommands(commands, "/model")[0]?.item.name).toBe("model");
    expect(rankSlashCommands(commands, "pro")[0]?.item.name).toBe("provider");
    expect(rankSlashCommands(commands, "m")[0]?.item.name).toBe("model");
    expect(rankSlashCommands(commands, "connect")[0]?.item.name).toBe("provider");
    expect(rankSlashCommands(commands, "secret")).toEqual([]);
  });

  test("does not interpret regex metacharacters and bounds unsafe input", () => {
    expect(() => rankSlashCommands(commands, "[.*+")).not.toThrow();
    expect(rankSlashCommands(commands, "model arg")).toEqual([]);
    expect(rankSlashCommands(commands, "x".repeat(257))).toEqual([]);
    expect(rankSlashCommands([{ name: `bad\0name` }], "bad")).toEqual([]);
  });

  test("ranks file basenames, subsequences, paths, and line-range queries", () => {
    const files = [
      { path: "src/components/Prompt.tsx" },
      { path: "src/prompt/history.ts" },
      { path: "test/prompt-history.test.ts" },
      { path: ".secret", hidden: true },
    ];
    expect(rankFileReferences(files, "@Prompt")[0]?.item.path).toBe("src/components/Prompt.tsx");
    expect(rankFileReferences(files, "s/p/h")[0]?.item.path).toBe("src/prompt/history.ts");
    expect(rankFileReferences(files, "Prompt.tsx#12-20")[0]?.item.path).toBe("src/components/Prompt.tsx");
    expect(rankFileReferences(files, "").map((result) => result.item.path)).not.toContain(".secret");
  });

  test("uses stable alphabetical ordering for empty equal-score queries and honors limits", () => {
    const ranked = rankFileReferences([{ path: "z.ts" }, { path: "a.ts" }, { path: "m.ts" }], "", { limit: 2 });
    expect(ranked.map((result) => result.item.path)).toEqual(["a.ts", "m.ts"]);
  });
});
