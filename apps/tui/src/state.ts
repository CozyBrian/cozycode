import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Tiny client-side state file for TUI preferences that outlive a run but do not
 * belong in the shared session config. Currently just the per-model reasoning
 * effort selection (keyed "providerID/modelID"), mirroring opencode's
 * client-owned model state. Writes are best-effort; a missing/corrupt file
 * falls back to defaults.
 */
export interface TuiState {
  version: 1;
  reasoningEffort: Record<string, string>;
}

// COZY_STATE_FILE overrides the location (used by tests to avoid the real home).
// Resolved per call so tests can set the env after the module is imported.
function stateFile(): string {
  return process.env.COZY_STATE_FILE ?? join(homedir(), ".config", "cozycode", "tui-state.json");
}

function defaults(): TuiState {
  return { version: 1, reasoningEffort: {} };
}

export function loadTuiState(): TuiState {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<TuiState>;
    if (parsed.version !== 1 || typeof parsed.reasoningEffort !== "object" || !parsed.reasoningEffort) {
      return defaults();
    }
    return { version: 1, reasoningEffort: parsed.reasoningEffort };
  } catch {
    return defaults();
  }
}

export function saveTuiState(state: TuiState): void {
  try {
    const file = stateFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state), "utf8");
  } catch {
    // Best-effort; a failed write just loses persistence for this change.
  }
}
