import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileTool, writeFileTool, editFileTool } from "../src/tools/fs.ts";
import { runShellTool } from "../src/tools/shell.ts";
import { searchTool } from "../src/tools/search.ts";
import { resolveInWorkspace } from "../src/tools/paths.ts";
import type { ShellResult } from "../src/tools/shell.ts";

let root: string;
const ctx = () => ({ workspaceRoot: root });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-test-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveInWorkspace", () => {
  test("resolves relative paths inside the workspace", () => {
    expect(resolveInWorkspace(root, "a/b.txt")).toBe(join(root, "a/b.txt"));
  });
  test("rejects traversal outside the workspace", () => {
    expect(() => resolveInWorkspace(root, "../escape.txt")).toThrow(/outside the workspace/);
  });
  test("rejects absolute paths outside the workspace", () => {
    expect(() => resolveInWorkspace(root, "/etc/passwd")).toThrow(/outside the workspace/);
  });
});

describe("file tools", () => {
  test("write then read round-trips", async () => {
    await writeFileTool.run({ path: "hello.txt", content: "hi there" }, ctx());
    const res = (await readFileTool.run({ path: "hello.txt" }, ctx())) as {
      content: string;
    };
    expect(res.content).toBe("hi there");
  });

  test("write creates parent directories", async () => {
    await writeFileTool.run({ path: "nested/deep/f.txt", content: "x" }, ctx());
    expect(await readFile(join(root, "nested/deep/f.txt"), "utf8")).toBe("x");
  });

  test("edit replaces a unique string", async () => {
    await writeFile(join(root, "code.ts"), "const a = 1;\nconst b = 2;\n");
    const res = (await editFileTool.run(
      { path: "code.ts", oldString: "const b = 2;", newString: "const b = 3;" },
      ctx(),
    )) as { replacements: number };
    expect(res.replacements).toBe(1);
    expect(await readFile(join(root, "code.ts"), "utf8")).toContain("const b = 3;");
  });

  test("edit throws on ambiguous match without replaceAll", async () => {
    await writeFile(join(root, "d.txt"), "x\nx\n");
    await expect(
      editFileTool.run({ path: "d.txt", oldString: "x", newString: "y" }, ctx()),
    ).rejects.toThrow(/appears 2 times/);
  });

  test("edit replaceAll replaces every occurrence", async () => {
    await writeFile(join(root, "d.txt"), "x\nx\nx\n");
    const res = (await editFileTool.run(
      { path: "d.txt", oldString: "x", newString: "y", replaceAll: true },
      ctx(),
    )) as { replacements: number };
    expect(res.replacements).toBe(3);
    expect(await readFile(join(root, "d.txt"), "utf8")).toBe("y\ny\ny\n");
  });

  test("edit throws when oldString is missing", async () => {
    await writeFile(join(root, "d.txt"), "abc");
    await expect(
      editFileTool.run({ path: "d.txt", oldString: "zzz", newString: "y" }, ctx()),
    ).rejects.toThrow(/not found/);
  });
});

describe("run_shell", () => {
  test("captures stdout and exit code", async () => {
    const res = (await runShellTool.run({ command: "echo hello" }, ctx())) as ShellResult;
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hello");
    expect(res.timedOut).toBe(false);
  });

  test("reports nonzero exit codes", async () => {
    const res = (await runShellTool.run({ command: "exit 3" }, ctx())) as ShellResult;
    expect(res.exitCode).toBe(3);
  });

  test("times out long-running commands", async () => {
    const res = (await runShellTool.run(
      { command: "sleep 5", timeoutMs: 100 },
      ctx(),
    )) as ShellResult;
    expect(res.timedOut).toBe(true);
  });

  test("runs in the workspace by default", async () => {
    const res = (await runShellTool.run({ command: "pwd" }, ctx())) as ShellResult;
    // macOS /tmp is a symlink to /private/tmp; compare the basename to avoid that.
    expect(res.stdout.trim().endsWith(root.split("/").pop()!)).toBe(true);
  });
});

describe("search", () => {
  beforeEach(async () => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src/a.ts"), "export const foo = 1;\n");
    await writeFile(join(root, "src/b.ts"), "export const bar = 2; // foo mention\n");
    await writeFile(join(root, "readme.md"), "# docs\n");
  });

  test("content search finds matches with line numbers", async () => {
    const res = (await searchTool.run({ pattern: "foo" }, ctx())) as {
      matches: string[];
      mode: string;
    };
    expect(res.mode).toBe("content");
    expect(res.matches.length).toBeGreaterThanOrEqual(2);
    expect(res.matches.some((m) => m.includes("a.ts"))).toBe(true);
  });

  test("glob-only lists matching files", async () => {
    const res = (await searchTool.run({ glob: "**/*.ts" }, ctx())) as {
      matches: string[];
      mode: string;
    };
    expect(res.mode).toBe("files");
    expect(res.matches.every((m) => m.endsWith(".ts"))).toBe(true);
    expect(res.matches.some((m) => m.includes("a.ts"))).toBe(true);
    expect(res.matches.some((m) => m.endsWith(".md"))).toBe(false);
  });
});
