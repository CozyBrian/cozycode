import { describe, expect, test } from "bun:test";
import {
  formatKeyChord,
  keyChordMatches,
  keyStrokeMatches,
  parseKeyChord,
  parseKeyChordList,
  parseKeyStroke,
} from "../src/input/index.ts";

describe("key chords", () => {
  test("parses modifiers and normalizes terminal aliases", () => {
    expect(parseKeyStroke("ctrl+shift+Enter")).toEqual({
      name: "return",
      ctrl: true,
      shift: true,
      meta: false,
      super: false,
      hyper: false,
    });
    expect(parseKeyStroke("alt+esc").name).toBe("escape");
    expect(parseKeyStroke("A").shift).toBe(true);
    expect(formatKeyChord(parseKeyChord("ctrl+comma shift+plus"))).toBe("ctrl+comma shift+plus");
  });

  test("expands a configurable leader into a sequence", () => {
    const chord = parseKeyChord("<leader>m", { leader: "ctrl+x" });
    expect(chord.map((stroke) => stroke.name)).toEqual(["x", "m"]);
    expect(chord[0]?.ctrl).toBe(true);
    expect(keyChordMatches(chord, [{ name: "x", ctrl: true }, { name: "m" }])).toBe(true);
  });

  test("parses comma-separated binding alternatives", () => {
    const chords = parseKeyChordList("ctrl+p, <leader>p", { leader: "ctrl+x" });
    expect(chords).toHaveLength(2);
    expect(chords.map(formatKeyChord)).toEqual(["ctrl+p", "ctrl+x p"]);
  });

  test("matches modifiers exactly and accepts alt as terminal meta", () => {
    expect(keyStrokeMatches(parseKeyStroke("alt+f"), { name: "f", meta: true })).toBe(true);
    expect(keyStrokeMatches(parseKeyStroke("ctrl+f"), { name: "f", ctrl: true, shift: true })).toBe(false);
  });

  test("rejects malformed chords", () => {
    expect(() => parseKeyStroke("ctrl+wat+x")).toThrow("Unknown key modifier");
    expect(() => parseKeyChord(" ")).toThrow("cannot be empty");
    expect(() => parseKeyChord("<leader>x", { leader: "<leader>" })).toThrow("cannot reference");
  });
});
