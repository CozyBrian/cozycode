import { describe, expect, test } from "bun:test";
import {
  DESKTOP_COMMANDS,
  formatShortcut,
  normalizeShortcut,
  resolveShortcut,
  sanitizeShortcutOverrides,
  toElectronAccelerator,
} from "../src/shared/desktop-commands.ts";

describe("desktop commands", () => {
  test("normalizes and formats portable shortcuts", () => {
    expect(normalizeShortcut("shift+mod+k")).toBe("Mod+Shift+K");
    expect(normalizeShortcut("K")).toBeNull();
    expect(formatShortcut("Mod+Shift+K", "darwin")).toBe("⌘⇧K");
    expect(formatShortcut("Mod+Shift+K", "win32")).toBe("Ctrl+Shift+K");
    expect(toElectronAccelerator("Mod+Backslash")).toBe("CmdOrCtrl+\\");
  });

  test("resolves defaults, overrides, and explicit unassignment", () => {
    const palette = DESKTOP_COMMANDS.find((command) => command.id === "palette.open")!;
    expect(resolveShortcut(palette)).toBe("Mod+K");
    expect(resolveShortcut(palette, { "palette.open": "Mod+Shift+P" })).toBe("Mod+Shift+P");
    expect(resolveShortcut(palette, { "palette.open": null })).toBeNull();
  });

  test("sanitizes persisted shortcut overrides", () => {
    expect(sanitizeShortcutOverrides({
      "palette.open": "shift+mod+p",
      "chat.new": null,
      unknown: "Mod+U",
      "project.open": "O",
    })).toEqual({
      "palette.open": "Mod+Shift+P",
      "chat.new": null,
    });
  });
});
