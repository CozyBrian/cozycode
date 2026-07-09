import { defineCommand, type CommandDef } from "./types.ts";

/**
 * Built-in commands — the single source of truth for every consumer (parser,
 * palette, help, autocomplete) across all frontends. Effects run through the
 * frontend-provided `CommandContext`, so a command means the same thing in the
 * TUI and desktop even though the underlying UI differs.
 */
export const COMMAND_DEFS: CommandDef[] = [
  defineCommand({
    name: "new",
    title: "New chat",
    aliases: ["clear"],
    category: "session",
    description: "Start a fresh session",
    run: (ctx) => ctx.newSession(),
  }),
  defineCommand({
    name: "model",
    title: "Switch model",
    aliases: ["models"],
    category: "session",
    description: "Switch model",
    args: [{ name: "id", description: "Model id or provider/model to switch to" }],
    run: (ctx, args) => {
      const id = args.trim();
      if (id && ctx.setModel) ctx.setModel(id);
      else ctx.openModelPicker();
    },
  }),
  defineCommand({
    name: "provider",
    title: "Connect provider",
    aliases: ["providers", "connect", "auth"],
    category: "session",
    description: "Connect or manage model providers",
    run: (ctx) => ctx.openProviderPicker(),
  }),
  defineCommand({
    name: "plan",
    title: "Plan mode",
    category: "mode",
    description: "Read-only research; no edits",
    run: (ctx) => ctx.setMode("plan"),
  }),
  defineCommand({
    name: "build",
    title: "Build mode",
    category: "mode",
    description: "Execute changes (default)",
    run: (ctx) => ctx.setMode("build"),
  }),
  defineCommand({
    name: "help",
    title: "Help",
    category: "app",
    description: "Show keybindings",
    run: (ctx) => ctx.showHelp(),
  }),
  defineCommand({
    name: "quit",
    title: "Quit",
    aliases: ["exit"],
    category: "app",
    description: "Exit cozycode",
    run: (ctx) => ctx.exit(),
  }),
];
