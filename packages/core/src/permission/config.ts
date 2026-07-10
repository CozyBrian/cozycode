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
 * Plan-mode overlay: denies file mutations. Merged over the base ruleset when
 * the session is in plan mode so edits are refused regardless of the base.
 */
export const PLAN_RULESET: Ruleset = rulesetFromConfig({ edit: "deny" });

/**
 * Safe-by-default ruleset. Reading and searching run freely; edits and shell
 * commands ask, except for a curated set of read-only shell commands (the old
 * shell-safety allowlist) that are allowed outright. Users override any of this
 * via config, which is merged last.
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
  bash: {
    "*": "ask",
    // read-only / non-mutating programs
    "pwd *": "allow",
    "ls *": "allow",
    "tree *": "allow",
    "find *": "allow",
    "rg *": "allow",
    "grep *": "allow",
    "cat *": "allow",
    "head *": "allow",
    "tail *": "allow",
    "less *": "allow",
    "more *": "allow",
    "wc *": "allow",
    "sort *": "allow",
    "uniq *": "allow",
    "which *": "allow",
    "whoami *": "allow",
    "date *": "allow",
    "echo *": "allow",
    "printenv *": "allow",
    "node *": "allow",
    "tsx *": "allow",
    "tsc *": "allow",
    // read-only git subcommands
    "git status *": "allow",
    "git diff *": "allow",
    "git log *": "allow",
    "git show *": "allow",
    "git branch *": "allow",
    "git rev-parse *": "allow",
    "git ls-files *": "allow",
    "git ls-remote *": "allow",
    "git remote *": "allow",
    "git blame *": "allow",
    "git grep *": "allow",
    // git config reads only
    "git config --get *": "allow",
    "git config --list *": "allow",
    "git config -l *": "allow",
    // package-runner read-only scripts
    "bun test *": "allow",
    "bun run test *": "allow",
    "bun run typecheck *": "allow",
    "npm test *": "allow",
    "npm run test *": "allow",
    "npm run typecheck *": "allow",
    "pnpm test *": "allow",
    "pnpm run test *": "allow",
    "pnpm run typecheck *": "allow",
    "yarn test *": "allow",
    "yarn run test *": "allow",
    "yarn run typecheck *": "allow",
  },
});

/** Full-access ruleset: everything allowed (the "full" desktop preset). */
export const FULL_ACCESS_RULESET: Ruleset = mergeRulesets(
  DEFAULT_RULESET,
  rulesetFromConfig("allow"),
);
