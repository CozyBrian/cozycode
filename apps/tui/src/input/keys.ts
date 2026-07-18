export interface KeyInput {
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  super?: boolean;
  hyper?: boolean;
}

export interface KeyStroke {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  super: boolean;
  hyper: boolean;
}

export type KeyChord = readonly KeyStroke[];

export interface ParseKeyChordOptions {
  leader?: string;
}

const KEY_ALIASES: Record<string, string> = {
  enter: "return",
  esc: "escape",
  pgup: "pageup",
  pgdn: "pagedown",
  pgdown: "pagedown",
  comma: ",",
  plus: "+",
};

const MODIFIERS: Record<string, keyof Pick<KeyStroke, "ctrl" | "shift" | "meta" | "super" | "hyper">> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "meta",
  option: "meta",
  meta: "meta",
  cmd: "super",
  command: "super",
  super: "super",
  hyper: "hyper",
};

export function parseKeyStroke(input: string): KeyStroke {
  const value = input.trim();
  if (!value) throw new Error("Key stroke cannot be empty");

  const parts = value.split("+");
  const rawName = parts.pop();
  if (!rawName) throw new Error(`Missing key name in "${input}"`);

  const stroke: KeyStroke = {
    name: normalizeKeyName(rawName),
    ctrl: false,
    shift: false,
    meta: false,
    super: false,
    hyper: false,
  };

  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) throw new Error(`Unknown key modifier "${part}" in "${input}"`);
    stroke[modifier] = true;
  }

  if (/^[A-Z]$/.test(rawName)) stroke.shift = true;
  return stroke;
}

export function parseKeyChord(input: string, options: ParseKeyChordOptions = {}): KeyChord {
  const value = input.trim();
  if (!value) throw new Error("Key chord cannot be empty");

  const leader = options.leader ?? "ctrl+x";
  if (/<leader>/i.test(leader)) throw new Error("Leader binding cannot reference <leader>");

  const expanded = value.replace(/<leader>/gi, ` ${leader} `).trim();
  if (!expanded) throw new Error(`Invalid key chord "${input}"`);
  return expanded.split(/\s+/).map(parseKeyStroke);
}

export function parseKeyChordList(input: string, options: ParseKeyChordOptions = {}): KeyChord[] {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => parseKeyChord(item, options));
}

export function normalizeKeyInput(input: KeyInput | string): KeyStroke {
  if (typeof input === "string") return parseKeyStroke(input);
  const parsedName = parseKeyStroke(input.name);
  return {
    name: parsedName.name,
    ctrl: Boolean(input.ctrl) || parsedName.ctrl,
    shift: Boolean(input.shift) || parsedName.shift,
    meta: Boolean(input.meta) || Boolean(input.alt) || parsedName.meta,
    super: Boolean(input.super) || parsedName.super,
    hyper: Boolean(input.hyper) || parsedName.hyper,
  };
}

export function keyStrokeMatches(expected: KeyStroke, input: KeyInput | KeyStroke | string): boolean {
  const actual = normalizeKeyInput(input);
  return (
    expected.name === actual.name &&
    expected.ctrl === actual.ctrl &&
    expected.shift === actual.shift &&
    expected.meta === actual.meta &&
    expected.super === actual.super &&
    expected.hyper === actual.hyper
  );
}

export function keyChordMatches(expected: KeyChord, input: readonly KeyInput[]): boolean {
  return expected.length === input.length && expected.every((stroke, index) => keyStrokeMatches(stroke, input[index]!));
}

export function isKeyChordPrefix(prefix: KeyChord, chord: KeyChord): boolean {
  return prefix.length <= chord.length && prefix.every((stroke, index) => keyStrokeMatches(stroke, chord[index]!));
}

export function formatKeyStroke(stroke: KeyStroke): string {
  const parts: string[] = [];
  if (stroke.ctrl) parts.push("ctrl");
  if (stroke.meta) parts.push("alt");
  if (stroke.shift) parts.push("shift");
  if (stroke.super) parts.push("super");
  if (stroke.hyper) parts.push("hyper");
  parts.push(stroke.name === "," ? "comma" : stroke.name === "+" ? "plus" : stroke.name);
  return parts.join("+");
}

export function formatKeyChord(chord: KeyChord): string {
  return chord.map(formatKeyStroke).join(" ");
}

function normalizeKeyName(input: string): string {
  const name = input.length === 1 ? input.toLowerCase() : input.toLowerCase();
  return KEY_ALIASES[name] ?? name;
}
