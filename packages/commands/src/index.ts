import { COMMAND_DEFS } from "./registry.ts";
import { parseCommandInput } from "./parse.ts";
import type { CommandContext, CommandDef } from "./types.ts";

export type { CommandContext, CommandArg, CommandDef } from "./types.ts";
export { defineCommand } from "./types.ts";
export { COMMAND_DEFS } from "./registry.ts";
export { parseCommandInput, tokenizeArgs, type ParsedCommand } from "./parse.ts";
export { resolveModelRef, type ResolveModelRefResult } from "./model-ref.ts";
export { modelKey, effortsForModel, resolveEffort, cycleEffort } from "./effort.ts";
export { SPINNER_VERBS, pickSpinnerVerb } from "./spinner-verbs.ts";

// Index of names + aliases → definition, built once at module load.
// future: register additional command providers here (user config, markdown
// files, prompt-template commands) by contributing into COMMAND_DEFS / this map.
const byName = new Map<string, CommandDef>();
for (const def of COMMAND_DEFS) {
  byName.set(def.name, def);
  for (const alias of def.aliases ?? []) byName.set(alias, def);
}

/** Resolve a command by canonical name or alias (case-insensitive). */
export function findCommand(name: string): CommandDef | undefined {
  return byName.get(name.toLowerCase());
}

export interface ListOptions {
  /** Include commands marked `hidden`. Defaults to false. */
  includeHidden?: boolean;
}

/** Canonical command list for palette / help UIs. */
export function listCommands(opts?: ListOptions): CommandDef[] {
  return opts?.includeHidden ? [...COMMAND_DEFS] : COMMAND_DEFS.filter((c) => !c.hidden);
}

/**
 * Commands whose name or an alias starts with `query` (without a leading
 * slash), for autocomplete. Empty query returns the full visible list.
 */
export function matchPrefix(query: string): CommandDef[] {
  const q = query.toLowerCase();
  return listCommands().filter(
    (c) => c.name.startsWith(q) || (c.aliases ?? []).some((a) => a.startsWith(q)),
  );
}

/**
 * Parse `input` and, if it is a slash command, dispatch it through `ctx`.
 * Returns true when the input was a command (handled — including the unknown
 * case, which notifies), false when it is plain text the caller should send.
 */
export async function runCommandInput(ctx: CommandContext, input: string): Promise<boolean> {
  const parsed = parseCommandInput(input);
  if (!parsed) return false;

  const command = findCommand(parsed.name);
  if (!command) {
    ctx.notify("error", `Unknown command: /${parsed.name}`);
    return true;
  }

  await command.run(ctx, parsed.args);
  return true;
}
