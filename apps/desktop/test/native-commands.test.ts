import { describe, expect, test } from "bun:test";
import { NATIVE_COMMANDS, isNativeCommand } from "../src/shared/ipc.ts";

describe("native commands", () => {
  test("uses a unique, closed command vocabulary", () => {
    expect(new Set(NATIVE_COMMANDS).size).toBe(NATIVE_COMMANDS.length);
    expect(isNativeCommand("new-chat")).toBe(true);
    expect(isNativeCommand("toggle-terminal")).toBe(true);
    expect(isNativeCommand("open-arbitrary-url")).toBe(false);
    expect(isNativeCommand({ command: "new-chat" })).toBe(false);
  });
});
