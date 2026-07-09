import { DEFAULT_PERMISSION_POLICY } from "@cozycode/core";
import type { AgentMode, PermissionPolicy } from "@cozycode/protocol";
import type { PermissionPreset } from "../shared/ipc.ts";

export interface ResolvedPreset {
  mode: AgentMode;
  policy: PermissionPolicy;
}

const FULL_ACCESS: PermissionPolicy = {
  defaultDecision: "allow",
  tools: {},
  shellDestructiveDecision: "allow",
};

/**
 * Map a UI permission preset to the core's mode + policy pair.
 *   full → build, allow everything (incl. destructive shell)
 *   ask  → build, the default ask-on-write policy
 *   plan → plan mode (read-only), default policy underneath
 */
export function resolvePreset(preset: PermissionPreset): ResolvedPreset {
  switch (preset) {
    case "full":
      return { mode: "build", policy: FULL_ACCESS };
    case "plan":
      return { mode: "plan", policy: DEFAULT_PERMISSION_POLICY };
    case "ask":
    default:
      return { mode: "build", policy: DEFAULT_PERMISSION_POLICY };
  }
}
