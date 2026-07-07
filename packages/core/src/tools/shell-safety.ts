/**
 * Shell command safety classifier.
 *
 * When `run_shell` policy is "ask", the permission gate uses this to decide
 * how to handle a command without surfacing an approval dialog for known-safe
 * ones. Commands are classified into three buckets:
 *
 *   - `safe`         — read-only / non-mutating; auto-allowed without prompting.
 *   - `destructive`  — known to mutate or destroy; resolved via the policy's
 *                       `shellDestructiveDecision` (defaults to "ask").
 *   - `unknown`       — unrecognized; always falls through to "ask".
 *
 * IMPORTANT: this is a conservative allowlist, not a general shell parser.
 * Any command that contains shell metacharacters or command substitution is
 * treated as `unknown` (never auto-allowed, never auto-denied).
 */

/** Shell metacharacters we never allow in an auto-allowed command. */
const SHELL_META_CHARS = /[;&|<>()`$\\{}[\]!'"]/;

/** Tri-state classification result. */
export type ShellClassification = "safe" | "destructive" | "unknown";

/** Programs that are known to mutate or destroy. */
const DESTRUCTIVE_PROGRAMS = new Set([
  "rm",
  "mv",
  "cp",
  "chmod",
  "chown",
  "kill",
  "pkill",
  "killall",
  "dd",
  "mkfs",
  "fdisk",
  "diskutil",
  "format",
]);

/** Git subcommands we consider read-only / non-mutating. */
const SAFE_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "ls-remote",
  "remote",
  "config",
  "blame",
  "grep",
]);

/** Git subcommands known to mutate or destroy. */
const DESTRUCTIVE_GIT_SUBCOMMANDS = new Set([
  "reset",
  "clean",
  "checkout",
  "restore",
  "switch",
  "commit",
  "push",
  "pull",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "stash",
  "clone",
  "init",
  "rm",
  "mv",
]);

/** Programs that are unconditionally safe to auto-allow. */
const SAFE_PROGRAMS = new Set([
  "pwd",
  "ls",
  "tree",
  "find",
  "rg",
  "grep",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "sort",
  "uniq",
  "which",
  "whoami",
  "date",
  "echo",
  "printenv",
  "node",
  "tsx",
  "tsc",
]);

/** Package manager / runner scripts that are safe read-only actions. */
const SAFE_RUN_SCRIPTS = new Set([
  "test",
  "typecheck",
]);

function tokenize(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function classifyPackageRunner(program: string, args: string[]): ShellClassification {
  if (!["bun", "npm", "pnpm", "yarn"].includes(program)) return "unknown";

  const runPrefix = args[0] === "run" ? 1 : 0;
  const script = args[runPrefix];

  if (script && SAFE_RUN_SCRIPTS.has(script)) return "safe";

  // `bun install`, `npm install`, etc. mutate the filesystem.
  if (args[0] === "install" || args[0] === "add" || args[0] === "remove" || args[0] === "uninstall") {
    return "destructive";
  }

  return "unknown";
}

function classifyGit(args: (string | undefined)[]): ShellClassification {
  if (args.length === 0) return "safe"; // bare `git` just prints help
  const sub = args[0]!;
  if (DESTRUCTIVE_GIT_SUBCOMMANDS.has(sub)) return "destructive";
  if (!SAFE_GIT_SUBCOMMANDS.has(sub)) return "unknown";

  // `git config` can write; only read (`--get`, `--list`) is safe.
  if (sub === "config") {
    const readFlags = new Set(["--get", "--list", "--local", "--global", "--system"]);
    return args.slice(1).some((a): a is string => typeof a === "string" && readFlags.has(a))
      ? "safe"
      : "destructive";
  }

  return "safe";
}

/**
 * Classify a shell command's safety level.
 *
 *   - `safe`        — auto-allow without prompting
 *   - `destructive` — known mutating; resolved via `shellDestructiveDecision`
 *   - `unknown`     — unrecognized; always falls through to "ask"
 */
export function classifyCommand(command: string): ShellClassification {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "safe"; // no-op

  if (SHELL_META_CHARS.test(trimmed)) return "unknown";

  const tokens = tokenize(trimmed);
  const program = tokens[0]!;
  const args = tokens.slice(1);

  if (DESTRUCTIVE_PROGRAMS.has(program)) return "destructive";
  if (SAFE_PROGRAMS.has(program)) return "safe";
  if (program === "git") return classifyGit(args);
  const runnerResult = classifyPackageRunner(program, args);
  if (runnerResult !== "unknown") return runnerResult;

  return "unknown";
}