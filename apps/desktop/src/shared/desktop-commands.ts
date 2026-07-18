export const DESKTOP_COMMANDS = [
  { id: "palette.open", title: "Open Command Palette", category: "Application", defaultShortcut: "Mod+K" },
  { id: "chat.new", title: "New Chat", category: "Chat", defaultShortcut: "Mod+N" },
  { id: "chat.newStandalone", title: "New Standalone Chat", category: "Chat", defaultShortcut: "Mod+Shift+N" },
  { id: "project.open", title: "Open Project", category: "Chat", defaultShortcut: "Mod+O" },
  { id: "terminal.new", title: "New Terminal", category: "Terminal", defaultShortcut: "Mod+Shift+J" },
  { id: "session.export", title: "Export Current Session", category: "Chat", defaultShortcut: "Mod+Shift+E" },
  { id: "settings.open", title: "Open Settings", category: "Application", defaultShortcut: "Mod+Comma" },
  { id: "view.sidebar.toggle", title: "Toggle Sidebar", category: "View", defaultShortcut: "Mod+B" },
  { id: "view.terminal.toggle", title: "Toggle Terminal", category: "View", defaultShortcut: "Mod+J" },
  { id: "view.contentPanel.toggle", title: "Toggle Content Panel", category: "View", defaultShortcut: "Mod+Backslash" },
  { id: "reasoning.effort.cycle", title: "Cycle Reasoning Effort", category: "Chat", defaultShortcut: "Mod+Shift+T" },
  { id: "navigation.back", title: "Navigate Back", category: "Navigation", defaultShortcut: "Mod+BracketLeft" },
  { id: "navigation.forward", title: "Navigate Forward", category: "Navigation", defaultShortcut: "Mod+BracketRight" },
  { id: "help.open", title: "Show Help", category: "Application" },
] as const;

export type DesktopCommandId = (typeof DESKTOP_COMMANDS)[number]["id"];
export type PortableShortcut = string;
export type ShortcutOverrides = Partial<Record<DesktopCommandId, PortableShortcut | null>>;

const commandIDs = new Set<string>(DESKTOP_COMMANDS.map((command) => command.id));
const namedKeys: Record<string, string> = {
  Comma: ",",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
};

export function isDesktopCommandId(value: unknown): value is DesktopCommandId {
  return typeof value === "string" && commandIDs.has(value);
}

export function normalizeShortcut(value: string): PortableShortcut | null {
  const parts = value.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const rawKey = parts.pop()!;
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  if (![...modifiers].every((part) => ["mod", "ctrl", "alt", "shift"].includes(part))) return null;
  if (!modifiers.has("mod") && !modifiers.has("ctrl") && !modifiers.has("alt")) return null;
  const key = normalizeKey(rawKey);
  if (!key) return null;
  const ordered = [
    modifiers.has("mod") ? "Mod" : null,
    modifiers.has("ctrl") ? "Ctrl" : null,
    modifiers.has("alt") ? "Alt" : null,
    modifiers.has("shift") ? "Shift" : null,
    key,
  ].filter(Boolean);
  return ordered.join("+");
}

function normalizeKey(value: string): string | null {
  const aliases: Record<string, string> = {
    ",": "Comma",
    comma: "Comma",
    "\\": "Backslash",
    backslash: "Backslash",
    "[": "BracketLeft",
    bracketleft: "BracketLeft",
    "]": "BracketRight",
    bracketright: "BracketRight",
  };
  const alias = aliases[value.toLowerCase()];
  if (alias) return alias;
  if (/^[a-z0-9]$/i.test(value)) return value.toUpperCase();
  return null;
}

export function resolveShortcut(
  command: (typeof DESKTOP_COMMANDS)[number],
  overrides?: ShortcutOverrides,
): PortableShortcut | null {
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, command.id)) {
    return overrides?.[command.id] ?? null;
  }
  return "defaultShortcut" in command ? command.defaultShortcut : null;
}

export function toElectronAccelerator(shortcut: PortableShortcut | null): string | undefined {
  if (!shortcut) return undefined;
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return undefined;
  return normalized
    .replace(/^Mod(?=\+|$)/, "CmdOrCtrl")
    .split("+")
    .map((part) => namedKeys[part] ?? part)
    .join("+");
}

export function formatShortcut(shortcut: PortableShortcut | null, platform: string): string {
  if (!shortcut) return "";
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return "";
  if (platform !== "darwin") {
    return normalized.replace("Mod", "Ctrl").replace("BracketLeft", "[").replace("BracketRight", "]").replace("Backslash", "\\").replace("Comma", ",");
  }
  const labels: Record<string, string> = {
    Mod: "⌘",
    Ctrl: "⌃",
    Alt: "⌥",
    Shift: "⇧",
    Comma: ",",
    Backslash: "\\",
    BracketLeft: "[",
    BracketRight: "]",
  };
  return normalized.split("+").map((part) => labels[part] ?? part).join("");
}

export function sanitizeShortcutOverrides(value: unknown): ShortcutOverrides | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: ShortcutOverrides = {};
  for (const [id, shortcut] of Object.entries(value)) {
    if (!isDesktopCommandId(id)) continue;
    if (shortcut === null) result[id] = null;
    else if (typeof shortcut === "string") {
      const normalized = normalizeShortcut(shortcut);
      if (normalized) result[id] = normalized;
    }
  }
  return Object.keys(result).length ? result : undefined;
}
