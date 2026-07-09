import type { AgentMode } from "@cozycode/protocol";

/**
 * Capabilities a frontend exposes so commands can drive its UI + session.
 * Each frontend implements this against its own effects (overlays, IPC, state).
 * Optional members degrade gracefully where a frontend lacks the affordance.
 */
export interface CommandContext {
  /** Switch the agent mode (build / plan). */
  setMode(mode: AgentMode): void;
  /** Reset the transcript and start a fresh session. */
  newSession(): void;
  /** Open the model-picker UI. */
  openModelPicker(): void;
  /** Open the provider-connection UI. */
  openProviderPicker(): void;
  /** Directly switch to a model by id or provider/model reference. */
  setModel?(id: string): void;
  /** Show the help / keybindings UI. */
  showHelp(): void;
  /** Exit the app. */
  exit(): void;
  /** Send a chat message to the session (for future prompt-template commands). */
  send(text: string): void;
  /** Surface a message to the user (errors, confirmations). */
  notify(kind: "error" | "info", text: string): void;
}

/** A positional argument a command accepts — powers hints and future validation. */
export interface CommandArg {
  name: string;
  description?: string;
  required?: boolean;
}

/** A single command definition — the unit the registry stores. */
export interface CommandDef {
  /** Canonical name, without the leading slash. */
  name: string;
  /** Human-friendly label for the palette; falls back to `name`. */
  title?: string;
  /** Alternate names that resolve to this command. */
  aliases?: string[];
  /** One-line description shown in palette / help / autocomplete. */
  description: string;
  /** Positional arguments, for hints and future validation. */
  args?: CommandArg[];
  /** Grouping used by the palette / help UIs. */
  category?: "session" | "mode" | "app";
  /** Hide from the palette and autocomplete (still runnable by name). */
  hidden?: boolean;
  /** Execute the command. `args` is the raw remainder after the command name. */
  run(ctx: CommandContext, args: string): void | Promise<void>;
}

/**
 * Author a command with type inference. Kept for parity with `defineTool`
 * and to give a single obvious entry point for future command providers.
 */
export function defineCommand(def: CommandDef): CommandDef {
  return def;
}
