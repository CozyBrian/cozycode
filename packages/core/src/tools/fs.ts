import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { defineTool } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

const MAX_READ_BYTES = 256 * 1024; // 256 KB guard so a huge file can't blow the context

export const readFileTool = defineTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace and return its contents. " +
    "Paths are relative to the workspace root.",
  inputSchema: z.object({
    path: z.string().describe("File path relative to the workspace root."),
  }),
  summarize: ({ path }) => `Read file ${path}`,
  async run({ path }, ctx) {
    const abs = resolveInWorkspace(ctx.workspaceRoot, path);
    const info = await stat(abs);
    if (!info.isFile()) throw new Error(`"${path}" is not a file.`);
    if (info.size > MAX_READ_BYTES) {
      throw new Error(
        `"${path}" is ${info.size} bytes; refusing to read files larger than ${MAX_READ_BYTES} bytes.`,
      );
    }
    const content = await readFile(abs, "utf8");
    return { path, content, bytes: info.size };
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  description:
    "Create or overwrite a text file in the workspace with the given content. " +
    "Parent directories are created as needed.",
  inputSchema: z.object({
    path: z.string().describe("File path relative to the workspace root."),
    content: z.string().describe("Full file content to write."),
  }),
  summarize: ({ path, content }) =>
    `Write ${content.length} bytes to ${path}`,
  async run({ path, content }, ctx) {
    const abs = resolveInWorkspace(ctx.workspaceRoot, path);
    const previous = await readFile(abs, "utf8").catch(() => "");
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    ctx.reportMetadata?.({ diff: createPatch(path, previous, content) });
    return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
  },
});

export const editFileTool = defineTool({
  name: "edit_file",
  description:
    "Make a precise edit to an existing file by replacing an exact string. " +
    "By default the old string must appear exactly once; set replaceAll to " +
    "replace every occurrence. Prefer a large, unambiguous old string.",
  inputSchema: z.object({
    path: z.string().describe("File path relative to the workspace root."),
    oldString: z
      .string()
      .describe("Exact text to find. Must be unique unless replaceAll is true."),
    newString: z.string().describe("Text to replace it with."),
    replaceAll: z
      .boolean()
      .optional()
      .describe("Replace every occurrence instead of requiring uniqueness."),
  }),
  summarize: ({ path }) => `Edit file ${path}`,
  async run({ path, oldString, newString, replaceAll }, ctx) {
    const abs = resolveInWorkspace(ctx.workspaceRoot, path);
    const original = await readFile(abs, "utf8");

    if (oldString === newString) {
      throw new Error("oldString and newString are identical; nothing to do.");
    }
    const occurrences = countOccurrences(original, oldString);
    if (occurrences === 0) {
      throw new Error(`oldString not found in ${path}.`);
    }
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `oldString appears ${occurrences} times in ${path}; make it unique or pass replaceAll.`,
      );
    }

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, newString);
    await writeFile(abs, updated, "utf8");
    ctx.reportMetadata?.({ diff: createPatch(path, original, updated) });
    return { path, replacements: replaceAll ? occurrences : 1 };
  },
});

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function createPatch(path: string, oldText: string, newText: string): string {
  return createTwoFilesPatch(path, path, oldText, newText, "", "", { context: 3 });
}
