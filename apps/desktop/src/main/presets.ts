import { DEFAULT_RULESET, FULL_ACCESS_RULESET } from "@cozycode/core";
import type { AgentMode, Ruleset } from "@cozycode/protocol";
import type { PermissionPreset } from "../shared/ipc.ts";

export interface ResolvedPreset {
  mode: AgentMode;
  ruleset: Ruleset;
}

/**
 * Map a UI permission preset to the core's mode + ruleset pair.
 *   full → build, allow everything
 *   ask  → build, the default ask-on-write ruleset
 *   plan → plan mode (read-only), default ruleset underneath; the Session
 *          applies the plan overlay (deny edits) on top by mode.
 */
export function resolvePreset(preset: PermissionPreset): ResolvedPreset {
  switch (preset) {
    case "full":
      return { mode: "build", ruleset: FULL_ACCESS_RULESET };
    case "plan":
      return { mode: "plan", ruleset: DEFAULT_RULESET };
    case "ask":
    default:
      return { mode: "build", ruleset: DEFAULT_RULESET };
  }
}
