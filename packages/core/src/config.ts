import type { PermissionPolicy } from "@cozycode/protocol";

/**
 * Safe-by-default policy: reading and searching run freely; anything that
 * mutates the workspace or runs a command must be approved.
 */
export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  defaultDecision: "ask",
  tools: {
    read_file: "allow",
    search: "allow",
    write_file: "ask",
    edit_file: "ask",
    run_shell: "ask",
  },
};

export const DEFAULT_SYSTEM_PROMPT = [
  "You are cozycode, a coding agent operating inside a user's workspace.",
  "You can read, write, and edit files, search the codebase, and run shell commands.",
  "Work in small, verifiable steps. Prefer reading a file before editing it.",
  "When you edit code, make targeted changes and explain what you did.",
  "Some actions require user approval; if one is denied, adapt or ask how to proceed.",
].join(" ");

export const PLAN_FILE_DIR = ".cozycode/plans";

/**
 * Appended to the system prompt while the agent is in plan mode. In plan mode
 * the mutating tools are hard-denied by the permission gate, EXCEPT for writes
 * to the plan file — which is the agent's one safe output channel. The prompt
 * tells the model to investigate, ask questions, and produce a concrete plan
 * by writing to the plan file.
 */
export const PLAN_MODE_PROMPT_ADDENDUM = [
  "Plan mode is active: you must NOT modify source files or run mutating commands.",
  "Mutating tools (write_file, edit_file) are blocked for all files except a single",
  `plan file under "${PLAN_FILE_DIR}/".`,
  "Write your implementation plan to that plan file using write_file and edit_file.",
  "Use read_file, search, and read-only shell commands to investigate the request,",
  "ask the user clarifying questions, then present a concrete implementation plan",
  "in the plan file. Do not begin implementation until the user switches back to",
  "build mode. The plan should cover: which files to modify, the order of changes,",
  "testing strategy, and any risks or alternatives to consider.",
].join(" ");

/**
 * Replaces the base system prompt when the agent transitions from plan to build
 * mode and a plan file already exists. It tells the model to execute the plan
 * rather than re-exploring from scratch.
 */
export const BUILD_AFTER_PLAN_PROMPT = [
  "You are now in build mode — execute the implementation plan.",
  `A plan file exists under "${PLAN_FILE_DIR}/". Read it, then follow it step by step.`,
  "Work in small, verifiable steps. Prefer reading a file before editing it.",
  "When you edit code, make targeted changes and explain what you did.",
  "If you encounter any deviation from the plan, update the plan file to reflect",
  "the actual implementation so the plan stays accurate.",
].join(" ");

export const DEFAULT_MAX_STEPS = 25;
