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

export const DEFAULT_MAX_STEPS = 25;
