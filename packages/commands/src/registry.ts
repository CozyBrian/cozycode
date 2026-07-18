import { defineCommand, type CommandContext, type CommandDef } from "./types.ts";

function runOptional(ctx: CommandContext, name: string, capability: (() => void) | undefined): void {
  if (capability) capability();
  else ctx.notify("error", `The /${name} command is not supported by this frontend.`);
}

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
    name: "sessions",
    title: "Switch session",
    aliases: ["session", "resume", "continue"],
    category: "session",
    description: "Search and switch open sessions",
    run: (ctx) => ctx.openSessionPicker?.(),
  }),
  defineCommand({
    name: "undo",
    title: "Undo previous turn",
    category: "session",
    description: "Undo the most recent turn",
    run: (ctx) => runOptional(ctx, "undo", ctx.undo),
  }),
  defineCommand({
    name: "redo",
    title: "Redo turn",
    category: "session",
    description: "Restore the most recently undone turn",
    run: (ctx) => runOptional(ctx, "redo", ctx.redo),
  }),
  defineCommand({
    name: "fork",
    title: "Fork session",
    category: "session",
    description: "Fork the active session",
    run: (ctx) => runOptional(ctx, "fork", ctx.forkSession),
  }),
  defineCommand({
    name: "delete",
    title: "Delete session",
    category: "session",
    description: "Delete the active session",
    run: (ctx) => runOptional(ctx, "delete", ctx.deleteSession),
  }),
  defineCommand({
    name: "timeline",
    title: "Message timeline",
    category: "session",
    description: "Open the active session's message timeline",
    run: (ctx) => runOptional(ctx, "timeline", ctx.openTimeline),
  }),
  defineCommand({
    name: "editor",
    title: "Open editor",
    category: "session",
    description: "Open the composer in an editor",
    run: (ctx) => runOptional(ctx, "editor", ctx.openEditor),
  }),
  defineCommand({
    name: "rename",
    title: "Rename session",
    category: "session",
    description: "Rename the active session",
    run: (ctx) => ctx.openRenameSession?.(),
  }),
  defineCommand({
    name: "export",
    title: "Export session",
    category: "session",
    description: "Export the active session as Markdown",
    args: [{ name: "path", description: "Optional output path" }],
    run: (ctx, args) => ctx.exportSession?.(args.trim() || undefined),
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
    name: "effort",
    title: "Reasoning effort",
    aliases: ["reasoning"],
    category: "session",
    description: "Set reasoning effort (reasoning models only)",
    args: [{ name: "level", description: "default, low, medium, high, …" }],
    run: (ctx, args) => {
      const level = args.trim();
      if (level && ctx.setEffort) ctx.setEffort(level);
      else ctx.openEffortPicker?.();
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
    aliases: ["exit", "q"],
    category: "app",
    description: "Exit cozycode",
    run: (ctx) => ctx.exit(),
  }),
];
