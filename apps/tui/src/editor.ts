import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface EditorExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface EditorSpawnOptions {
  cwd: string;
  stdio: "inherit";
  shell: false;
}

export type EditorSpawn = (
  executable: string,
  args: string[],
  options: EditorSpawnOptions,
) => Promise<EditorExit>;

export interface ExternalEditorOptions {
  editor?: string;
  env?: Pick<NodeJS.ProcessEnv, "EDITOR" | "VISUAL">;
  suspend: () => void | Promise<void>;
  resume: () => void | Promise<void>;
  cwd?: string;
  tempDirectory?: string;
  spawn?: EditorSpawn;
}

export type ExternalEditorErrorCode =
  | "missing-editor"
  | "malformed-command"
  | "spawn-failed"
  | "nonzero-exit";

export class ExternalEditorError extends Error {
  constructor(
    readonly code: ExternalEditorErrorCode,
    readonly draft: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ExternalEditorError";
  }
}

export function parseEditorCommand(command: string): [executable: string, ...args: string[]] {
  if (command.includes("\0")) throw new Error("Editor command contains a null byte.");

  const parts: string[] = [];
  let part = "";
  let quote: "'" | '"' | undefined;
  let started = false;

  const finishPart = () => {
    if (!started) return;
    parts.push(part);
    part = "";
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;

    if (quote) {
      if (character === quote) {
        quote = undefined;
        started = true;
      } else if (character === "\\" && quote === '"' && command[index + 1] === '"') {
        part += '"';
        started = true;
        index += 1;
      } else {
        part += character;
        started = true;
      }
      continue;
    }

    if (/\s/.test(character)) {
      finishPart();
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }

    if (character === "\\") {
      const next = command[index + 1];
      if (next !== undefined && (/\s/.test(next) || next === "'" || next === '"')) {
        part += next;
        started = true;
        index += 1;
      } else {
        // Preserve path separators, including Windows drive and UNC paths.
        part += character;
        started = true;
      }
      continue;
    }

    part += character;
    started = true;
  }

  if (quote) throw new Error(`Editor command has an unterminated ${quote} quote.`);
  finishPart();
  if (!parts[0]) throw new Error("Editor command does not contain an executable.");
  return parts as [executable: string, ...args: string[]];
}

export function normalizeEditorText(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

export async function openExternalEditor(
  initialText: string,
  options: ExternalEditorOptions,
): Promise<string> {
  const env = options.env ?? process.env;
  const editor = options.editor !== undefined
    ? options.editor
    : firstNonBlank(env.VISUAL, env.EDITOR);
  if (!editor?.trim()) {
    throw new ExternalEditorError(
      "missing-editor",
      initialText,
      "No external editor is configured. Set VISUAL or EDITOR.",
    );
  }

  let command: [executable: string, ...args: string[]];
  try {
    command = parseEditorCommand(editor);
  } catch (cause) {
    throw new ExternalEditorError(
      "malformed-command",
      initialText,
      `Invalid external editor command: ${errorMessage(cause)}`,
      { cause },
    );
  }

  const directory = await mkdtemp(join(options.tempDirectory ?? tmpdir(), "cozycode-editor-"));
  const file = join(directory, "prompt.md");
  let suspendAttempted = false;
  try {
    await writeFile(file, initialText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    suspendAttempted = true;
    await options.suspend();

    let exit: EditorExit;
    try {
      exit = await (options.spawn ?? spawnAndWait)(
        command[0],
        [...command.slice(1), file],
        {
          cwd: options.cwd ?? process.cwd(),
          stdio: "inherit",
          shell: false,
        },
      );
    } catch (cause) {
      throw new ExternalEditorError(
        "spawn-failed",
        initialText,
        `Could not start external editor: ${errorMessage(cause)}`,
        { cause },
      );
    }

    if (exit.code !== 0) {
      const status = exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? "unknown"}`;
      throw new ExternalEditorError(
        "nonzero-exit",
        initialText,
        `External editor exited with ${status}.`,
      );
    }

    return normalizeEditorText(await readFile(file, "utf8"));
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      if (suspendAttempted) await options.resume();
    }
  }
}

function firstNonBlank(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

function spawnAndWait(
  executable: string,
  args: string[],
  options: EditorSpawnOptions,
): Promise<EditorExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
