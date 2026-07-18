import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  expandWorkspaceReferences,
  indexWorkspaceReferences,
  parseFileReferences,
  resolveWorkspaceReference,
  searchWorkspaceReferenceCandidates,
} from "../src/prompt/index.ts";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-refs-"));
  outside = `${root}-outside.txt`;
});

afterEach(async () => {
  await chmod(join(root, "private.txt"), 0o600).catch(() => {});
  await rm(root, { recursive: true, force: true });
  await rm(outside, { force: true });
});

describe("workspace reference discovery", () => {
  test("indexes bounded candidates and supports safe fuzzy search", async () => {
    await mkdir(join(root, "src", "components"), { recursive: true });
    await writeFile(join(root, "src", "components", "Prompt.tsx"), "export const Prompt = 1\n");
    await writeFile(join(root, "src", "history.ts"), "export const history = []\n");

    const index = indexWorkspaceReferences(root);
    expect(index.workspaceRoot).toBe(await realpath(root));
    expect(index.candidates).toContainEqual({ path: "src", directory: true });
    expect(index.candidates.some((candidate) => candidate.path === "src/components/Prompt.tsx")).toBe(true);
    expect(searchWorkspaceReferenceCandidates(index, "prmpt")[0]?.item.path).toBe("src/components/Prompt.tsx");
  });

  test("caps filesystem discovery and reports truncation", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => writeFile(join(root, `file-${index}.txt`), String(index))),
    );
    const index = indexWorkspaceReferences(root, { maxCandidates: 3, maxScannedEntries: 4 });
    expect(index.candidates.length).toBeLessThanOrEqual(3);
    expect(index.warnings.some((warning) => warning.code === "discovery-limit")).toBe(true);
  });
});

describe("workspace reference parsing", () => {
  test("parses every boundary-safe path, normalizes separators, and retains line ranges", () => {
    expect(parseFileReferences("Use @src\\Prompt.tsx#2-4 and (@README.md)."))
      .toEqual([
        {
          raw: "@src\\Prompt.tsx#2-4",
          path: "src/Prompt.tsx",
          range: { start: 2, end: 4 },
          textStart: 4,
          textEnd: 23,
        },
        {
          raw: "@README.md",
          path: "README.md",
          textStart: 29,
          textEnd: 39,
        },
      ]);
  });

  test("does not treat email-like text as a file reference", () => {
    const text = "Email person@example.com, then read @README.md";
    expect(parseFileReferences(text).map((reference) => reference.path)).toEqual(["README.md"]);
  });

  test("marks zero, reversed, incomplete, and non-numeric ranges as malformed", () => {
    const references = parseFileReferences("@a.txt#0-2 @b.txt#3-2 @c.txt#1- @d.txt#abc");
    expect(references.map((reference) => reference.malformedRange)).toEqual(["0-2", "3-2", "1-", "abc"]);
  });
});

describe("workspace reference expansion", () => {
  test("expands line ranges without changing display text", async () => {
    await writeFile(join(root, "notes.txt"), "one\r\ntwo\r\nthree\r\nfour\r\n");
    const displayText = "Review @notes.txt#2-3 please";
    const result = expandWorkspaceReferences(displayText, root);

    expect(result.displayText).toBe(displayText);
    expect(result.modelText).toStartWith(displayText);
    expect(result.modelText).toContain('path="notes.txt" lines="2-3"');
    expect(result.modelText).toContain("2: two\n3: three");
    expect(result.modelText).not.toContain("1: one");
    expect(result.references).toEqual([
      {
        raw: "@notes.txt#2-3",
        path: "notes.txt",
        kind: "file",
        range: { start: 2, end: 3 },
        bytes: 15,
        entries: 1,
      },
    ]);
  });

  test("deduplicates normalized and symlink-equivalent references", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "alpha");
    await symlink(join(root, "src", "a.txt"), join(root, "alias.txt"));
    const displayText = "@src/a.txt @./src/a.txt @alias.txt";
    expect(parseFileReferences(displayText)).toHaveLength(3);

    const result = expandWorkspaceReferences(displayText, root);
    expect(result.displayText).toBe(displayText);
    expect(result.references).toHaveLength(1);
    expect(result.modelText.match(/<workspace-file/g)).toHaveLength(1);
  });

  test("does not charge duplicate mentions against the unique reference limit", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    await writeFile(join(root, "b.txt"), "bravo");
    const result = expandWorkspaceReferences("@a.txt @a.txt @b.txt", root, { maxReferences: 2 });
    expect(result.references.map((reference) => reference.path)).toEqual(["a.txt", "b.txt"]);
    expect(result.warnings.some((warning) => warning.code === "reference-limit")).toBe(false);
  });

  test("represents directories as recursive bounded file listings", async () => {
    await mkdir(join(root, "docs", "nested"), { recursive: true });
    await writeFile(join(root, "docs", "a.txt"), "a");
    await writeFile(join(root, "docs", "b.txt"), "b");
    await writeFile(join(root, "docs", "nested", "c.txt"), "c");

    const result = expandWorkspaceReferences("Read @docs", root, { maxDirectoryEntries: 2 });
    expect(result.references).toMatchObject([{ path: "docs", kind: "directory", entries: 2 }]);
    expect(result.modelText).toContain("docs/a.txt");
    expect(result.modelText).toContain("docs/b.txt");
    expect(result.modelText).not.toContain("docs/nested/c.txt");
    expect(result.warnings.some((warning) => warning.code === "directory-entry-limit")).toBe(true);
  });

  test("rejects lexical traversal and symlinks escaping the canonical workspace", async () => {
    await writeFile(outside, "secret");
    await symlink(outside, join(root, "escape.txt"));
    const traversal = `../${basename(outside)}`;

    expect(resolveWorkspaceReference(root, traversal)).toMatchObject({
      ok: false,
      warning: { code: "outside-workspace" },
    });
    expect(resolveWorkspaceReference(root, "escape.txt")).toMatchObject({
      ok: false,
      warning: { code: "outside-workspace" },
    });

    const result = expandWorkspaceReferences(`Do not read @${traversal} or @escape.txt`, root);
    expect(result.references).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["outside-workspace", "outside-workspace"]);
  });

  test("skips binary and oversized files with explicit warnings", async () => {
    await writeFile(join(root, "binary.dat"), Buffer.from([1, 2, 3, 4]));
    await writeFile(join(root, "large.txt"), "x".repeat(32));
    const result = expandWorkspaceReferences("@binary.dat @large.txt", root, { maxFileBytes: 16 });

    expect(result.references).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["binary", "file-byte-limit"]);
  });

  test("enforces total entry and byte limits", async () => {
    await writeFile(join(root, "a.txt"), "a".repeat(20));
    await writeFile(join(root, "b.txt"), "b".repeat(20));
    const entries = expandWorkspaceReferences("@a.txt @b.txt", root, { maxTotalEntries: 1 });
    expect(entries.references).toHaveLength(1);
    expect(entries.warnings.some((warning) => warning.code === "total-entry-limit")).toBe(true);

    const bytes = expandWorkspaceReferences("@a.txt @b.txt", root, { maxTotalBytes: 150 });
    expect(bytes.references.length).toBeLessThan(2);
    expect(bytes.warnings.some((warning) => warning.code === "total-byte-limit")).toBe(true);
  });

  test("warns for malformed and out-of-bounds ranges without adding context", async () => {
    await writeFile(join(root, "a.txt"), "one\ntwo");
    const result = expandWorkspaceReferences("@a.txt#2-1 @a.txt#99", root);
    expect(result.references).toEqual([]);
    expect(result.modelText).toBe(result.displayText);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["malformed-range", "malformed-range"]);
  });

  test("reports unreadable files when platform permissions deny access", async () => {
    const file = join(root, "private.txt");
    await writeFile(file, "private");
    await chmod(file, 0o000);
    const result = expandWorkspaceReferences("@private.txt", root);

    if (typeof process.getuid === "function" && process.getuid() === 0) {
      expect(result.references.length + result.warnings.length).toBeGreaterThan(0);
      return;
    }
    expect(result.references).toEqual([]);
    expect(result.warnings).toMatchObject([{ code: "unreadable", reference: "@private.txt" }]);
  });
});
