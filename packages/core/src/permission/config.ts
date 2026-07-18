import { homedir } from "node:os";
import type { PermissionConfig, Ruleset } from "@cozycode/protocol";

/** Expand `~` / `$HOME` prefixes in a config pattern to the home directory. */
function expand(pattern: string): string {
  if (pattern === "~") return homedir();
  if (pattern.startsWith("~/")) return homedir() + pattern.slice(1);
  if (pattern.startsWith("$HOME")) return homedir() + pattern.slice("$HOME".length);
  return pattern;
}

/**
 * Flatten an opencode-style permission config into a `Ruleset`. A bare action
 * becomes `{ "*": action }` over every category; a category mapped to an action
 * applies to every pattern; a per-pattern map produces one rule per entry.
 * Object key order is preserved so config precedence is last-match-wins.
 */
export function rulesetFromConfig(config: PermissionConfig): Ruleset {
  if (typeof config === "string") {
    return [{ permission: "*", pattern: "*", action: config }];
  }
  const ruleset: Ruleset = [];
  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === "string") {
      ruleset.push({ permission, pattern: "*", action: value });
      continue;
    }
    for (const [pattern, action] of Object.entries(value)) {
      ruleset.push({ permission, pattern: expand(pattern), action });
    }
  }
  return ruleset;
}

/** Concatenate rulesets; later rules override earlier ones (last-match-wins). */
export function mergeRulesets(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat();
}

/**
 * Plan-mode overlay: edits and shell are always denied. Shell command names are
 * not a security boundary because arguments, config, and hooks can add side
 * effects; plan-mode inspection uses the dedicated read and search tools.
 */
export const PLAN_RULESET: Ruleset = rulesetFromConfig({
  edit: "deny",
  bash: "deny",
});

/**
 * Safe-by-default ruleset. Reading and searching run freely; edits and shell
 * commands ask. Users override any of this via config, which is merged last.
 */
export const DEFAULT_RULESET: Ruleset = rulesetFromConfig({
  "*": "ask",
  read: "allow",
  search: "allow",
  edit: "ask",
  // Delegating to a subagent is allowed by default (overridable to ask/deny).
  task: "allow",
  // Maintaining the todo checklist is harmless bookkeeping — never prompt.
  todowrite: "allow",
  bash: "ask",
});

/** Full-access ruleset: everything allowed (the "full" desktop preset). */
export const FULL_ACCESS_RULESET: Ruleset = mergeRulesets(
  DEFAULT_RULESET,
  rulesetFromConfig("allow"),
);
