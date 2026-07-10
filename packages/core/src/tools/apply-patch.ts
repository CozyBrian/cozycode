import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { defineTool } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

/**
 * Applies an OpenAI-style V4A patch (the `apply_patch` envelope) describing
 * add/update/delete across one or more files in a single call:
 *
 *   *** Begin Patch
 *   *** Add File: path/new.ts
 *   +contents
 *   *** Update File: path/existing.ts
 *   @@ optional context
 *    context line
 *   -removed
 *   +added
 *   *** Delete File: path/old.ts
 *   *** End Patch
 */
export const applyPatchTool = defineTool({
  name: "apply_patch",
  description:
    "Apply a multi-file patch in the V4A `apply_patch` format (*** Begin Patch / " +
    "*** Add|Update|Delete File: / @@ / +/-/space lines / *** End Patch). Use it " +
    "to add, edit, or delete several files atomically in one call. For update " +
    "hunks, include a few unchanged context lines (prefixed with a space) so the " +
    "location is unambiguous.",
  inputSchema: z.object({
    patchText: z.string().describe("The full patch text, including the Begin/End Patch markers."),
  }),
  summarize: ({ patchText }) => {
    const files = [...patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].length;
    return `Apply patch to ${files} ${files === 1 ? "file" : "files"}`;
  },
  async run({ patchText }, ctx) {
    const hunks = parsePatch(patchText);
    if (hunks.length === 0) throw new Error("No file sections found in patch.");

    const patches: Array<{ path: string; diff: string }> = [];
    const results: Array<{ path: string; type: Hunk["type"] }> = [];

    for (const hunk of hunks) {
      const abs = resolveInWorkspace(ctx.workspaceRoot, hunk.path);
      if (hunk.type === "add") {
        const previous = await readFile(abs, "utf8").catch(() => null);
        if (previous !== null) throw new Error(`Add File: "${hunk.path}" already exists.`);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, hunk.contents, "utf8");
        patches.push({ path: hunk.path, diff: createPatch(hunk.path, "", hunk.contents) });
      } else if (hunk.type === "delete") {
        const previous = await readFile(abs, "utf8").catch(() => "");
        await rm(abs, { force: true });
        patches.push({ path: hunk.path, diff: createPatch(hunk.path, previous, "") });
      } else {
        const original = await readFile(abs, "utf8");
        const updated = applyUpdate(original, hunk.chunks, hunk.path);
        const destPath = hunk.movePath ?? hunk.path;
        const destAbs = hunk.movePath ? resolveInWorkspace(ctx.workspaceRoot, hunk.movePath) : abs;
        await mkdir(dirname(destAbs), { recursive: true });
        await writeFile(destAbs, updated, "utf8");
        if (hunk.movePath) await rm(abs, { force: true });
        patches.push({ path: destPath, diff: createPatch(destPath, original, updated) });
      }
      results.push({
        path: hunk.type === "update" && hunk.movePath ? hunk.movePath : hunk.path,
        type: hunk.type,
      });
    }

    // Combine per-file patches so the existing diff renderers show every change.
    ctx.reportMetadata?.({ diff: patches.map((p) => p.diff).join("\n"), files: results });
    return { files: results };
  },
});

interface AddHunk {
  type: "add";
  path: string;
  contents: string;
}
interface DeleteHunk {
  type: "delete";
  path: string;
}
interface UpdateHunk {
  type: "update";
  path: string;
  movePath?: string;
  chunks: string[][]; // each chunk is a list of `[ +-]line` strings
}
type Hunk = AddHunk | DeleteHunk | UpdateHunk;

/** Parse the V4A envelope into per-file hunks. */
function parsePatch(patchText: string): Hunk[] {
  const lines = patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i]!.startsWith("*** Begin Patch")) i++;
  if (i < lines.length) i++; // skip Begin Patch

  const hunks: Hunk[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith("*** End Patch")) break;

    const add = line.match(/^\*\*\* Add File: (.+)$/);
    const del = line.match(/^\*\*\* Delete File: (.+)$/);
    const upd = line.match(/^\*\*\* Update File: (.+)$/);

    if (add) {
      i++;
      const body: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        body.push(lines[i]!.replace(/^\+/, ""));
        i++;
      }
      hunks.push({ type: "add", path: add[1]!.trim(), contents: body.join("\n") });
    } else if (del) {
      i++;
      hunks.push({ type: "delete", path: del[1]!.trim() });
    } else if (upd) {
      i++;
      let movePath: string | undefined;
      if (i < lines.length && lines[i]!.startsWith("*** Move to: ")) {
        movePath = lines[i]!.slice("*** Move to: ".length).trim();
        i++;
      }
      const chunks: string[][] = [];
      let current: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        if (lines[i]!.startsWith("@@")) {
          if (current.length) chunks.push(current);
          current = [];
        } else {
          current.push(lines[i]!);
        }
        i++;
      }
      if (current.length) chunks.push(current);
      hunks.push({ type: "update", path: upd[1]!.trim(), movePath, chunks });
    } else {
      i++; // skip stray lines
    }
  }
  return hunks;
}

/** Apply update chunks by matching each chunk's context+removed block and replacing it. */
function applyUpdate(original: string, chunks: string[][], path: string): string {
  let content = original;
  for (const chunk of chunks) {
    const before: string[] = [];
    const after: string[] = [];
    for (const raw of chunk) {
      if (raw.startsWith("+")) after.push(raw.slice(1));
      else if (raw.startsWith("-")) before.push(raw.slice(1));
      else {
        const ctx = raw.startsWith(" ") ? raw.slice(1) : raw;
        before.push(ctx);
        after.push(ctx);
      }
    }
    const beforeBlock = before.join("\n");
    const afterBlock = after.join("\n");
    if (beforeBlock === "") {
      // Pure insertion with no anchor — append.
      content = content.endsWith("\n") || content === "" ? content + afterBlock : content + "\n" + afterBlock;
      continue;
    }
    const idx = content.indexOf(beforeBlock);
    if (idx === -1) {
      throw new Error(`apply_patch: could not locate a hunk's context in "${path}".`);
    }
    if (content.indexOf(beforeBlock, idx + beforeBlock.length) !== -1) {
      throw new Error(`apply_patch: a hunk's context is ambiguous in "${path}" (matches more than once).`);
    }
    content = content.slice(0, idx) + afterBlock + content.slice(idx + beforeBlock.length);
  }
  return content;
}

function createPatch(path: string, oldText: string, newText: string): string {
  return createTwoFilesPatch(path, path, oldText, newText, "", "", { context: 3 });
}
