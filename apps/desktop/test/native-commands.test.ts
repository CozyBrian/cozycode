import { describe, expect, test } from "bun:test";
import { NATIVE_COMMANDS, isNativeCommand } from "../src/shared/ipc.ts";

describe("native commands", () => {
  test("uses a unique, closed command vocabulary", () => {
    expect(new Set(NATIVE_COMMANDS).size).toBe(NATIVE_COMMANDS.length);
    expect(isNativeCommand("chat.new")).toBe(true);
    expect(isNativeCommand("chat.newStandalone")).toBe(true);
    expect(isNativeCommand("view.terminal.toggle")).toBe(true);
    expect(isNativeCommand("open-arbitrary-url")).toBe(false);
    expect(isNativeCommand({ command: "new-chat" })).toBe(false);
  });
});
