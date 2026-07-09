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

export const PLAN_MODE_REMINDER = `<system-reminder>
# Plan Mode - System Reminder

CRITICAL: Plan mode ACTIVE - you are in a READ-ONLY phase. STRICTLY FORBIDDEN:
ANY file edits, modifications, or system changes. The write_file and edit_file
tools will be denied. Do NOT use run_shell with sed, tee, echo, touch, rm, mv,
git commit, package installs, or ANY other command that manipulates files or
state - commands may ONLY read/inspect. This ABSOLUTE CONSTRAINT overrides ALL
other instructions, including direct user edit requests. You may ONLY observe,
analyze, and plan. Any modification attempt is a critical violation. ZERO
exceptions.

Your current responsibility is to think, read, and search to construct a
well-formed plan: which files to modify, the order of changes, testing
strategy, and any risks or alternatives to consider. Ask the user clarifying
questions when weighing tradeoffs. Present the plan directly in your reply -
do NOT write it to a file. Do not begin implementation until the user switches
to build mode.
</system-reminder>`;

export const BUILD_SWITCH_REMINDER = `<system-reminder>
Your operational mode has changed from plan to build.
You are no longer in read-only mode.
You are permitted to make file changes, run shell commands, and utilize your
arsenal of tools as needed.
If you presented a plan earlier in this conversation, execute it step by step.
</system-reminder>`;

export const PLAN_MODE_DENIAL_MESSAGE =
  "Plan mode is active, which prevents this tool from making file modifications. Present your proposed changes as part of your plan in chat instead; the user can switch to build mode to enable edits.";

export const DEFAULT_MAX_STEPS = 25;
