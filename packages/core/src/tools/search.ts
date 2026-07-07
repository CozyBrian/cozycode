import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { defineTool } from "./types.ts";
import { resolveInWorkspace } from "./paths.ts";

const MAX_MATCHES = 200;
const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "out", ".next"]);

export const searchTool = defineTool({
  name: "search",
  description:
    "Search the workspace. Provide `pattern` for a content search (regex), " +
    "and/or `glob` to restrict to matching file paths. With only `glob`, lists " +
    "matching files. Uses ripgrep when available and falls back to a built-in scan.",
  inputSchema: z
    .object({
      pattern: z
        .string()
        .optional()
        .describe("Regex to search file contents for."),
      glob: z
        .string()
        .optional()
        .describe('File glob, e.g. "**/*.ts". Filters which files are searched/listed.'),
      path: z
        .string()
        .optional()
        .describe("Subdirectory to scope the search to (relative to workspace root)."),
    })
    .refine((v) => v.pattern || v.glob, {
      message: "Provide at least one of `pattern` or `glob`.",
    }),
  summarize: ({ pattern, glob }) =>
    pattern ? `Search for /${pattern}/${glob ? ` in ${glob}` : ""}` : `List files ${glob}`,
  async run({ pattern, glob, path }, ctx) {
    const root = path ? resolveInWorkspace(ctx.workspaceRoot, path) : ctx.workspaceRoot;
    const hasRg = await ripgrepAvailable();
    if (hasRg) {
      return runRipgrep({ pattern, glob, root, workspaceRoot: ctx.workspaceRoot });
    }
    return runFallback({ pattern, glob, root, workspaceRoot: ctx.workspaceRoot });
  },
});

interface SearchArgs {
  pattern?: string;
  glob?: string;
  root: string;
  workspaceRoot: string;
}

let rgAvailable: boolean | undefined;
function ripgrepAvailable(): Promise<boolean> {
  if (rgAvailable !== undefined) return Promise.resolve(rgAvailable);
  return new Promise((res) => {
    const child = spawn("rg", ["--version"]);
    child.on("error", () => res((rgAvailable = false)));
    child.on("close", (code) => res((rgAvailable = code === 0)));
  });
}

function runRipgrep(args: SearchArgs): Promise<unknown> {
  const rgArgs = args.pattern
    ? ["--line-number", "--no-heading", "--color", "never", "--max-count", "50"]
    : ["--files"];
  if (args.glob) rgArgs.push("-g", args.glob);
  if (args.pattern) rgArgs.push("--", args.pattern);
  rgArgs.push(args.root);

  return new Promise((resolvePromise) => {
    const child = spawn("rg", rgArgs);
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("close", () => {
      const lines = out
        .split("\n")
        .filter(Boolean)
        .slice(0, MAX_MATCHES)
        .map((l) => l.replace(args.workspaceRoot + "/", ""));
      resolvePromise({
        mode: args.pattern ? "content" : "files",
        matches: lines,
        truncated: out.split("\n").filter(Boolean).length > MAX_MATCHES,
      });
    });
  });
}

async function runFallback(args: SearchArgs): Promise<unknown> {
  const globRe = args.glob ? globToRegExp(args.glob) : undefined;
  const contentRe = args.pattern ? new RegExp(args.pattern) : undefined;
  const matches: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    if (matches.length >= MAX_MATCHES) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= MAX_MATCHES) return;
      const full = join(dir, entry.name);
      const rel = relative(args.workspaceRoot, full);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        await walk(full);
      } else if (entry.isFile()) {
        if (globRe && !globRe.test(rel)) continue;
        if (!contentRe) {
          matches.push(rel);
          continue;
        }
        const info = await stat(full);
        if (info.size > 1024 * 1024) continue;
        const text = await readFile(full, "utf8").catch(() => "");
        text.split("\n").forEach((line, i) => {
          if (matches.length >= MAX_MATCHES) return;
          if (contentRe.test(line)) matches.push(`${rel}:${i + 1}:${line.trim()}`);
        });
      }
    }
  };

  await walk(args.root);
  return {
    mode: args.pattern ? "content" : "files",
    matches: matches.slice(0, MAX_MATCHES),
    truncated: matches.length >= MAX_MATCHES,
    usedFallback: true,
  };
}

/** Minimal glob -> RegExp supporting `**`, `*`, and `?`. Matches against a relative path. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c as string)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`(^|/)${re}$`);
}
