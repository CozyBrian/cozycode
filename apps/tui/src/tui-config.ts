import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseKeyChord, parseKeyChordList } from "./input/keys.ts";

export const TUI_ACTION_NAMES = [
  "session.new",
  "session.list",
  "sidebar.toggle",
  "model.open",
  "palette.open",
  "session.undo",
  "session.redo",
  "session.commit",
  "session.timeline",
  "editor.open",
  "help.open",
  "app.quit",
  "effort.cycle",
  "session.abort",
  "dialog.cancel",
  "app.exit",
] as const;

export type TuiActionName = (typeof TUI_ACTION_NAMES)[number];
export type TuiKeybinding = string | string[] | false | "none";

/** A validated partial configuration, ready to merge over app defaults. */
export interface TuiConfig {
  leader?: string;
  leaderTimeoutMs?: number;
  keybinds?: Partial<Record<TuiActionName, TuiKeybinding>>;
}

export interface LoadedTuiConfig {
  config: TuiConfig;
  diagnostics: string[];
}

const ACTION_NAMES = new Set<string>(TUI_ACTION_NAMES);
const DEFAULT_LEADER = "ctrl+x";
const MAX_TIMEOUT_MS = 2_147_483_647;

export function tuiConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "CozyCode");
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "cozycode");
}

/**
 * Load global JSON then JSONC, followed by an explicit override. This mirrors
 * OpenCode's TUI config precedence while keeping every parse/validation failure
 * nonfatal.
 */
export function loadTuiConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): LoadedTuiConfig {
  const directory = tuiConfigDirectory(env, platform, home);
  const defaults = [join(directory, "tui.json"), join(directory, "tui.jsonc")];
  const files = env.COZY_TUI_CONFIG && !defaults.includes(env.COZY_TUI_CONFIG)
    ? [...defaults, env.COZY_TUI_CONFIG]
    : defaults;
  const diagnostics: string[] = [];
  let config: TuiConfig = {};

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && file !== env.COZY_TUI_CONFIG) continue;
      diagnostics.push(`${file}: ${errorMessage(error)}`);
      continue;
    }

    try {
      const parsed = validateConfig(parseJsonc(source), file, diagnostics);
      config = mergeConfig(config, parsed);
    } catch (error) {
      diagnostics.push(`${file}: ${errorMessage(error)}`);
    }
  }

  return { config, diagnostics };
}

function validateConfig(value: unknown, file: string, diagnostics: string[]): TuiConfig {
  if (!isRecord(value)) {
    diagnostics.push(`${file}: config must be a JSON object`);
    return {};
  }

  for (const key of Object.keys(value)) {
    if (key !== "$schema" && key !== "leader_timeout" && key !== "keybinds") {
      diagnostics.push(`${file}: unknown config field "${key}"`);
    }
  }
  if ("$schema" in value && typeof value.$schema !== "string") {
    diagnostics.push(`${file}: "$schema" must be a string`);
  }

  const result: TuiConfig = {};
  if ("leader_timeout" in value) {
    if (
      typeof value.leader_timeout === "number"
      && Number.isInteger(value.leader_timeout)
      && value.leader_timeout >= 0
      && value.leader_timeout <= MAX_TIMEOUT_MS
    ) {
      result.leaderTimeoutMs = value.leader_timeout;
    } else {
      diagnostics.push(`${file}: "leader_timeout" must be a non-negative integer`);
    }
  }

  if (!("keybinds" in value)) return result;
  if (!isRecord(value.keybinds)) {
    diagnostics.push(`${file}: "keybinds" must be an object`);
    return result;
  }

  let leader = DEFAULT_LEADER;
  if ("leader" in value.keybinds) {
    if (typeof value.keybinds.leader === "string" && validLeader(value.keybinds.leader)) {
      leader = value.keybinds.leader;
      result.leader = leader;
    } else {
      diagnostics.push(`${file}: "keybinds.leader" must be a valid key chord without <leader>`);
    }
  }

  const keybinds: Partial<Record<TuiActionName, TuiKeybinding>> = {};
  for (const [name, binding] of Object.entries(value.keybinds)) {
    if (name === "leader") continue;
    if (!ACTION_NAMES.has(name)) {
      diagnostics.push(`${file}: unknown action "${name}"`);
      continue;
    }
    if (!isKeybinding(binding) || !validKeybinding(binding, leader)) {
      diagnostics.push(`${file}: invalid keybinding for "${name}"`);
      continue;
    }
    keybinds[name as TuiActionName] = Array.isArray(binding) ? [...binding] : binding;
  }
  if (Object.keys(keybinds).length > 0) result.keybinds = keybinds;
  return result;
}

function mergeConfig(base: TuiConfig, next: TuiConfig): TuiConfig {
  const merged: TuiConfig = { ...base, ...next };
  if (base.keybinds || next.keybinds) merged.keybinds = { ...base.keybinds, ...next.keybinds };
  return merged;
}

function validLeader(value: string): boolean {
  if (!value.trim() || /<leader>/i.test(value)) return false;
  try {
    return parseKeyChord(value).length > 0;
  } catch {
    return false;
  }
}

function isKeybinding(value: unknown): value is TuiKeybinding {
  return value === false
    || value === "none"
    || (typeof value === "string" && value.length > 0)
    || (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0));
}

function validKeybinding(value: TuiKeybinding, leader: string): boolean {
  if (value === false || value === "none") return true;
  try {
    if (typeof value === "string") return parseKeyChordList(value, { leader }).length > 0;
    return value.every((item) => parseKeyChordList(item, { leader }).length > 0);
  } catch {
    return false;
  }
}

function parseJsonc(source: string): unknown {
  const input = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    const next = input[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        output += character;
      } else output += " ";
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        output += "  ";
        blockComment = false;
        index++;
      } else output += character === "\n" || character === "\r" ? character : " ";
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      output += "  ";
      lineComment = true;
      index++;
    } else if (character === "/" && next === "*") {
      output += "  ";
      blockComment = true;
      index++;
    } else output += character;
  }
  if (blockComment) throw new Error("unterminated block comment");

  let json = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < output.length; index++) {
    const character = output[index]!;
    if (inString) {
      json += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      json += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < output.length && /\s/.test(output[next]!)) next++;
      if (output[next] === "}" || output[next] === "]") {
        json += " ";
        continue;
      }
    }
    json += character;
  }
  return JSON.parse(json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
