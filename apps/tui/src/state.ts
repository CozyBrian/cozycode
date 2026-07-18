import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ModelRef } from "@cozycode/protocol";

/**
 * Client-owned TUI preferences that outlive a run but do not belong in the
 * shared session config.
 */
export interface TuiState {
  version: 2;
  reasoningEffort: Record<string, string>;
  recentModels: ModelRef[];
  sidebarMode: TuiSidebarMode;
}

export type TuiSidebarMode = "auto" | "open" | "closed";

export const TUI_RECENT_MODELS_LIMIT = 8;

// Resolved per call so tests and embedders can change the environment after
// importing this module.
export function tuiStateFile(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.COZY_STATE_FILE ?? join(home, ".config", "cozycode", "tui-state.json");
}

export function tuiDataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "CozyCode", "tui");
  }
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "CozyCode", "tui");
  }
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), "cozycode", "tui");
}

export function tuiSessionFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.COZY_TUI_SESSION_FILE ?? join(tuiDataDirectory(env), "sessions.sqlite");
}

export function tuiPromptHistoryFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(tuiSessionFile(env)), "prompt-history.jsonl");
}

export function tuiSnapshotDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(tuiSessionFile(env)), "snapshots");
}

function defaults(): TuiState {
  return { version: 2, reasoningEffort: {}, recentModels: [], sidebarMode: "auto" };
}

export function loadTuiState(): TuiState {
  try {
    return normalizeState(JSON.parse(readFileSync(tuiStateFile(), "utf8")));
  } catch {
    return defaults();
  }
}

export function saveTuiState(state: TuiState): void {
  const file = tuiStateFile();
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const temporary = join(
    directory,
    `.${basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(normalizeState(state), null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function normalizeState(value: unknown): TuiState {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) return defaults();

  return {
    version: 2,
    reasoningEffort: stringRecord(value.reasoningEffort),
    recentModels: value.version === 2 ? recentModels(value.recentModels) : [],
    sidebarMode: value.version === 2 && isSidebarMode(value.sidebarMode) ? value.sidebarMode : "auto",
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => entry[0].length > 0 && typeof entry[1] === "string" && entry[1].length > 0,
    ),
  );
}

function recentModels(value: unknown): ModelRef[] {
  if (!Array.isArray(value)) return [];
  const result: ModelRef[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.providerID !== "string" || !item.providerID) continue;
    if (typeof item.modelID !== "string" || !item.modelID) continue;
    const key = `${item.providerID}\u0000${item.modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ providerID: item.providerID, modelID: item.modelID });
    if (result.length === TUI_RECENT_MODELS_LIMIT) break;
  }
  return result;
}

function isSidebarMode(value: unknown): value is TuiSidebarMode {
  return value === "auto" || value === "open" || value === "closed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
