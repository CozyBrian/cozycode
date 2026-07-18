import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExternalEditorError,
  normalizeEditorText,
  openExternalEditor,
  parseEditorCommand,
  type EditorSpawn,
} from "../src/editor.ts";

describe("parseEditorCommand", () => {
  test("parses arguments, quoted executables, escaped spaces, and Windows paths", () => {
    expect(parseEditorCommand("code --wait")).toEqual(["code", "--wait"]);
    expect(parseEditorCommand('"/Applications/Visual Studio Code.app/bin/code" --wait')).toEqual([
      "/Applications/Visual Studio Code.app/bin/code",
      "--wait",
    ]);
    expect(parseEditorCommand(String.raw`/Applications/Visual\ Studio\ Code.app/bin/code --wait`)).toEqual([
      "/Applications/Visual Studio Code.app/bin/code",
      "--wait",
    ]);
    expect(parseEditorCommand(String.raw`"C:\Program Files\Editor\editor.exe" --wait`)).toEqual([
      String.raw`C:\Program Files\Editor\editor.exe`,
      "--wait",
    ]);
    expect(parseEditorCommand(String.raw`C:\tools\editor.exe --wait`)).toEqual([
      String.raw`C:\tools\editor.exe`,
      "--wait",
    ]);
  });

  test("preserves empty quoted arguments and rejects malformed commands", () => {
    expect(parseEditorCommand('code "" --wait')).toEqual(["code", "", "--wait"]);
    expect(() => parseEditorCommand("   ")).toThrow("executable");
    expect(() => parseEditorCommand('"unterminated')).toThrow("unterminated");
    expect(() => parseEditorCommand("code\0--wait")).toThrow("null byte");
  });
});

describe("normalizeEditorText", () => {
  test("removes exactly one conventional trailing newline", () => {
    expect(normalizeEditorText("hello\n")).toBe("hello");
    expect(normalizeEditorText("hello\r\n")).toBe("hello");
    expect(normalizeEditorText("first\nsecond\n")).toBe("first\nsecond");
    expect(normalizeEditorText("first\n\n")).toBe("first\n");
  });

  test("does not trim any other content", () => {
    expect(normalizeEditorText("  hello  ")).toBe("  hello  ");
    expect(normalizeEditorText("first\r\nsecond")).toBe("first\r\nsecond");
    expect(normalizeEditorText("")).toBe("");
  });
});

describe("openExternalEditor", () => {
  test("suspends before spawn, reads the edit, cleans up, then resumes", async () => {
    const events: string[] = [];
    let file = "";
    const spawn: EditorSpawn = async (_executable, args, options) => {
      file = args.at(-1)!;
      expect(events).toEqual(["suspend"]);
      expect(options).toMatchObject({ stdio: "inherit", shell: false });
      expect(await readFile(file, "utf8")).toBe("original draft");
      events.push("spawn");
      await writeFile(file, "edited draft\n");
      return { code: 0, signal: null };
    };

    const result = await openExternalEditor("original draft", {
      editor: "code --wait",
      suspend: () => events.push("suspend"),
      resume: async () => {
        await expect(access(file)).rejects.toThrow();
        events.push("resume");
      },
      spawn,
    });

    expect(result).toBe("edited draft");
    expect(events).toEqual(["suspend", "spawn", "resume"]);
  });

  test("passes editor and temporary paths containing spaces without a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "cozycode editor test "));
    try {
      const tempDirectory = join(root, "temporary files");
      await mkdir(tempDirectory);
      const editor = join(root, "Editor App", "editor executable");
      let temporaryFile = "";
      const spawn: EditorSpawn = async (executable, args, options) => {
        temporaryFile = args.at(-1)!;
        expect(executable).toBe(editor);
        expect(args.slice(0, -1)).toEqual(["--wait"]);
        expect(temporaryFile.startsWith(tempDirectory)).toBe(true);
        expect(options.shell).toBe(false);
        await writeFile(temporaryFile, "edited");
        return { code: 0, signal: null };
      };

      await expect(openExternalEditor("draft", {
        editor: `"${editor}" --wait`,
        tempDirectory,
        suspend() {},
        resume() {},
        spawn,
      })).resolves.toBe("edited");
      await expect(access(temporaryFile)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses explicit, VISUAL, then EDITOR command precedence", async () => {
    const executables: string[] = [];
    const spawn: EditorSpawn = async (executable) => {
      executables.push(executable);
      return { code: 0, signal: null };
    };
    const lifecycle = { suspend() {}, resume() {}, spawn };

    await openExternalEditor("draft", {
      ...lifecycle,
      editor: "explicit",
      env: { VISUAL: "visual", EDITOR: "editor" },
    });
    await openExternalEditor("draft", {
      ...lifecycle,
      env: { VISUAL: "visual", EDITOR: "editor" },
    });
    await openExternalEditor("draft", {
      ...lifecycle,
      env: { VISUAL: " ", EDITOR: "editor" },
    });

    expect(executables).toEqual(["explicit", "visual", "editor"]);
  });

  test("rejects a nonzero exit, restores the renderer, and retains the draft", async () => {
    let temporaryFile = "";
    let resumed = false;
    const promise = openExternalEditor("keep this draft", {
      editor: "editor",
      suspend() {},
      resume: async () => {
        await expect(access(temporaryFile)).rejects.toThrow();
        resumed = true;
      },
      spawn: async (_executable, args) => {
        temporaryFile = args.at(-1)!;
        await writeFile(temporaryFile, "replacement");
        return { code: 17, signal: null };
      },
    });

    try {
      await promise;
      throw new Error("Expected the editor operation to reject.");
    } catch (error) {
      expect(error).toBeInstanceOf(ExternalEditorError);
      expect(error).toMatchObject({ code: "nonzero-exit", draft: "keep this draft" });
    }
    expect(resumed).toBe(true);
  });

  test("rejects missing, malformed, and failed editor commands with the original draft", async () => {
    const lifecycle = { suspend() {}, resume() {} };
    await expect(openExternalEditor("draft", {
      ...lifecycle,
      env: {},
    })).rejects.toMatchObject({ code: "missing-editor", draft: "draft" });
    await expect(openExternalEditor("draft", {
      ...lifecycle,
      editor: '"unterminated',
    })).rejects.toMatchObject({ code: "malformed-command", draft: "draft" });
    await expect(openExternalEditor("draft", {
      ...lifecycle,
      editor: "missing-editor",
      spawn: async () => {
        throw new Error("ENOENT");
      },
    })).rejects.toMatchObject({ code: "spawn-failed", draft: "draft" });
  });
});
