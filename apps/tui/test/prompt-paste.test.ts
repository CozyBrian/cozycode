import { describe, expect, test } from "bun:test";
import {
  expandPastePlaceholders,
  insertPastedText,
  normalizePastedText,
  preparePastedText,
  restorePastedText,
} from "../src/prompt/index.ts";

describe("multiline paste", () => {
  test("normalizes CRLF and bare CR at the boundary", () => {
    expect(normalizePastedText("one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  test("keeps short pastes inline and replaces selections", () => {
    const result = insertPastedText("hello world", 6, 11, "cozy\r\ncode", { minimumLines: 3 });
    expect(result).toEqual({
      text: "hello cozy\ncode",
      cursor: 15,
      normalized: "cozy\ncode",
    });
  });

  test("summarizes multiline text while retaining reversible content", () => {
    const pasted = "one\r\ntwo\r\nthree\n";
    const result = insertPastedText("before after", 7, 7, pasted, { id: "paste-1" });
    expect(result.text).toBe("before [Pasted ~3 lines]after");
    expect(result.placeholder).toMatchObject({ id: "paste-1", content: "one\ntwo\nthree\n", lineCount: 3 });
    expect(restorePastedText(result.text, [result.placeholder!])).toBe("before one\ntwo\nthree\nafter");
  });

  test("expands multiple tracked placeholders from the end", () => {
    const first = insertPastedText("", 0, 0, "a\nb\nc", { id: "a" });
    const second = insertPastedText(first.text, first.text.length, first.text.length, "1\n2\n3", { id: "b" });
    const expanded = expandPastePlaceholders(second.text, [first.placeholder!, second.placeholder!]);
    expect(expanded).toEqual({ text: "a\nb\nc1\n2\n3", unresolved: [] });
  });

  test("does not replace a placeholder that the user edited", () => {
    const result = insertPastedText("", 0, 0, "a\nb\nc", { id: "paste" });
    const edited = result.text.replace("Pasted", "Edited");
    expect(expandPastePlaceholders(edited, [result.placeholder!])).toEqual({
      text: edited,
      unresolved: ["paste"],
    });
  });

  test("supports length summaries, custom labels, and disabling summaries", () => {
    expect(preparePastedText("x".repeat(151)).summarized).toBe(true);
    expect(preparePastedText("a\nb\nc", { placeholder: ({ lineCount }) => `<${lineCount}>` }).insertion).toBe("<3>");
    expect(preparePastedText("a\nb\nc", { summarize: false }).insertion).toBe("a\nb\nc");
  });
});
