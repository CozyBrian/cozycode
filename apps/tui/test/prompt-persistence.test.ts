import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPromptHistoryStore,
  createPromptStashStore,
  parsePromptHistory,
  parsePromptStash,
} from "../src/prompt/index.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-prompt-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("prompt history persistence", () => {
  test("salvages JSONL, validates entries, deduplicates neighbors, and caps", () => {
    const lines = [
      JSON.stringify({ text: "old" }),
      "not-json",
      JSON.stringify({ text: 7 }),
      JSON.stringify({ text: "same" }),
      JSON.stringify({ text: "same" }),
      JSON.stringify({ text: "shell", mode: "shell" }),
      JSON.stringify({ text: "invalid", mode: "other" }),
      JSON.stringify({ text: "new" }),
    ];
    expect(parsePromptHistory(lines.join("\n"), 3)).toEqual([
      { text: "same" },
      { text: "shell", mode: "shell" },
      { text: "new" },
    ]);
  });

  test("persists append, ignores blanks/latest duplicates, and reloads", async () => {
    const file = join(root, "state", "history.jsonl");
    const history = createPromptHistoryStore<{ files: string[] }>(file, { limit: 2 });
    let changes = 0;
    history.subscribe(() => changes++);

    expect(history.append({ text: "   " })).toBe(false);
    expect(history.append({ text: "one", data: { files: ["a.ts"] } })).toBe(true);
    expect(history.append({ text: "one", data: { files: ["a.ts"] } })).toBe(false);
    history.append({ text: "two" });
    history.append({ text: "three" });

    expect(history.getSnapshot().map((entry) => entry.text)).toEqual(["two", "three"]);
    expect(changes).toBe(3);
    expect((await readFile(file, "utf8")).trim().split("\n")).toHaveLength(2);
    expect(createPromptHistoryStore(file).getSnapshot().map((entry) => entry.text)).toEqual(["two", "three"]);
  });

  test("loads around malformed lines and rewrites a clean bounded file on mutation", async () => {
    const file = join(root, "history.jsonl");
    await writeFile(file, `${JSON.stringify({ text: "one" })}\nbroken\n${JSON.stringify({ text: "two" })}\n`);
    const history = createPromptHistoryStore(file, { limit: 2 });
    expect(history.getSnapshot().map((entry) => entry.text)).toEqual(["one", "two"]);
    history.append({ text: "three" });
    expect((await readFile(file, "utf8")).trim().split("\n").map(JSON.parse)).toEqual([
      { text: "two" },
      { text: "three" },
    ]);
  });

  test("rejects non-serializable history data without throwing", () => {
    const history = createPromptHistoryStore<unknown>(join(root, "history.jsonl"));
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(history.append({ text: "bad", data: circular })).toBe(false);
    expect(history.getSnapshot()).toEqual([]);
  });
});

describe("prompt stash persistence", () => {
  test("parses valid capped stash entries around corruption", () => {
    const lines = [
      JSON.stringify({ id: "1", createdAt: 1, text: "one" }),
      "broken",
      JSON.stringify({ id: "bad", createdAt: "now", text: "bad" }),
      JSON.stringify({ id: "2", createdAt: 2, text: "two" }),
      JSON.stringify({ id: "3", createdAt: 3, text: "three" }),
    ];
    expect(parsePromptStash(lines.join("\n"), 2).map((entry) => entry.id)).toEqual(["2", "3"]);
  });

  test("pushes, caps, removes, pops, and survives recreation", () => {
    const file = join(root, "state", "stash.jsonl");
    let id = 0;
    let now = 10;
    const options = { limit: 2, createID: () => String(++id), now: () => now++ };
    const stash = createPromptStashStore(file, options);
    stash.push({ text: "one" });
    const two = stash.push({ text: "two", mode: "shell" });
    stash.push({ text: "three" });

    expect(stash.getSnapshot().map((entry) => entry.text)).toEqual(["two", "three"]);
    expect(stash.remove(two!.id)?.text).toBe("two");
    expect(stash.pop()?.text).toBe("three");
    expect(stash.pop()).toBeUndefined();
    expect(createPromptStashStore(file).getSnapshot()).toEqual([]);
  });
});
