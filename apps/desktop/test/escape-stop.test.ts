import { describe, expect, test } from "bun:test";
import {
  confirmsEscapeStop,
  ESCAPE_STOP_WINDOW_MS,
} from "../src/renderer/src/chat/escape-stop.ts";

describe("double-Escape stop confirmation", () => {
  test("requires a primed timestamp", () => {
    expect(confirmsEscapeStop(null, 1_000)).toBe(false);
  });

  test("confirms through the end of the three-second window", () => {
    expect(confirmsEscapeStop(1_000, 1_001)).toBe(true);
    expect(confirmsEscapeStop(1_000, 1_000 + ESCAPE_STOP_WINDOW_MS)).toBe(true);
  });

  test("rejects expired and clock-reversed timestamps", () => {
    expect(confirmsEscapeStop(1_000, 1_001 + ESCAPE_STOP_WINDOW_MS)).toBe(false);
    expect(confirmsEscapeStop(1_000, 999)).toBe(false);
  });
});
