import type { WebContents } from "electron";
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { promisify } from "node:util";
import { IPC, type GitFileStatus, type GitStatus } from "../shared/ipc.ts";

const run = promisify(execFile);

const EMPTY: GitStatus = { isRepo: false, branch: null, ahead: 0, behind: 0, files: [] };

/** Debounce window for coalescing watcher bursts (a single save fires many events). */
const REFRESH_DEBOUNCE_MS = 300;
/**
 * Owns a read-only view of the active session's git working tree for one
 * window. Mirrors `TerminalManager`: `setCwd` follows the active session, a
 * recursive fs watcher pushes fresh status on change. Uses `git` via
 * `execFile` (no shell, no extra deps); a missing repo degrades to an empty
 * snapshot rather than throwing.
 */
export class GitManager {
  private cwd: string | null = null;
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly web: WebContents) {}

  /** Follow the active session's workspace; restart the watcher and push status. */
  setCwd(root: string | null): void {
    if (root === this.cwd) return;
    this.cwd = root;
    this.restartWatcher();
    void this.pushStatus();
  }

  private async git(args: string[]): Promise<string> {
    if (!this.cwd) throw new Error("No workspace root.");
    const { stdout } = await run("git", args, { cwd: this.cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  async status(): Promise<GitStatus> {
    if (!this.cwd) return EMPTY;
    let porcelain: string;
    try {
      porcelain = await this.git(["status", "--porcelain=v2", "--branch"]);
    } catch {
      return EMPTY; // Not a repo (or git unavailable).
    }
    // +/- counts come from numstat; merge staged + unstaged by path.
    const counts = new Map<string, { additions: number; deletions: number }>();
    for (const staged of [false, true]) {
      let numstat = "";
      try {
        numstat = await this.git(staged ? ["diff", "--cached", "--numstat"] : ["diff", "--numstat"]);
      } catch {
        // ignore — leave counts at zero for these paths
      }
      for (const line of numstat.split("\n")) {
        if (!line.trim()) continue;
        const [add, del, ...rest] = line.split("\t");
        const path = rest.join("\t");
        if (!path) continue;
        const prev = counts.get(path) ?? { additions: 0, deletions: 0 };
        // "-" marks binary files; treat as zero.
        prev.additions += Number(add) || 0;
        prev.deletions += Number(del) || 0;
        counts.set(path, prev);
      }
    }
    return parsePorcelain(porcelain, counts);
  }

  /** Unified diff for one path (index diff when `staged`, else working-tree). */
  async diff(path: string, staged: boolean): Promise<string> {
    if (!this.cwd) return "";
    try {
      if (staged) return await this.git(["diff", "--cached", "--", path]);
      const tracked = await this.git(["diff", "--", path]);
      // Empty working-tree diff usually means the path is untracked; show its
      // contents as an all-add patch instead of a blank pane.
      return tracked.trim() ? tracked : await this.untrackedDiff(path);
    } catch {
      return "";
    }
  }

  /** Full-file diff for an untracked path (all-add), via a no-index comparison. */
  private async untrackedDiff(path: string): Promise<string> {
    try {
      // git exits 1 when files differ, which rejects; capture stdout regardless.
      await this.git(["diff", "--no-index", "--", "/dev/null", path]);
      return "";
    } catch (err) {
      const stdout = (err as { stdout?: string }).stdout;
      return typeof stdout === "string" ? stdout : "";
    }
  }

  private restartWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
    if (!this.cwd) return;
    try {
      this.watcher = watch(this.cwd, { recursive: true }, (_event, filename) => {
        const name = typeof filename === "string" ? filename : "";
        // Ignore internal git churn and dependency noise so a single edit
        // triggers exactly one refresh.
        if (name.includes(".git/") || name.startsWith(".git") || name.includes("node_modules/")) return;
        this.scheduleRefresh();
      });
    } catch {
      // Recursive watch can fail on some platforms/filesystems; the pane still
      // works via the initial fetch and manual refresh.
      this.watcher = null;
    }
  }

  private scheduleRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.pushStatus();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async pushStatus(): Promise<void> {
    const status = await this.status();
    if (!this.web.isDestroyed()) this.web.send(IPC.gitChanged, status);
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    this.watcher?.close();
    this.watcher = null;
  }
}

/**
 * Parse `git status --porcelain=v2 --branch` output into a `GitStatus`.
 * Record kinds: `# branch.*` headers, `1`/`2` (ordinary/rename changes),
 * `u` (unmerged), `?` (untracked). The XY code's two chars are the staged
 * and unstaged states respectively.
 */
function parsePorcelain(
  out: string,
  counts: Map<string, { additions: number; deletions: number }>,
): GitStatus {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];

  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head === "(detached)" ? null : head;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        ahead = Number(m[1]) || 0;
        behind = Number(m[2]) || 0;
      }
      continue;
    }
    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const rename = line.startsWith("2 ");
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      // Ordinary: fields 0-7 then path; rename: an extra score field before path.
      const rest = line.split(" ").slice(rename ? 9 : 8).join(" ");
      // Rename path field is "new\told"; keep the new path.
      const path = rename ? rest.split("\t")[0]! : rest;
      files.push(fileStatus(path, xy, counts, rename));
      continue;
    }
    if (line.startsWith("u ")) {
      const path = line.split(" ").slice(10).join(" ");
      files.push({ path, status: "conflicted", staged: true, unstaged: true, ...count(counts, path) });
      continue;
    }
    if (line.startsWith("? ")) {
      const path = line.slice(2);
      files.push({ path, status: "untracked", staged: false, unstaged: true, additions: 0, deletions: 0 });
      continue;
    }
  }

  return { isRepo: true, branch, ahead, behind, files };
}

function fileStatus(
  path: string,
  xy: string,
  counts: Map<string, { additions: number; deletions: number }>,
  rename: boolean,
): GitFileStatus {
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  const staged = x !== "." && x !== "?";
  const unstaged = y !== ".";
  const code = staged ? x : y;
  const status: GitFileStatus["status"] = rename
    ? "renamed"
    : code === "A"
      ? "added"
      : code === "D"
        ? "deleted"
        : "modified";
  return { path, status, staged, unstaged, ...count(counts, path) };
}

function count(
  counts: Map<string, { additions: number; deletions: number }>,
  path: string,
): { additions: number; deletions: number } {
  return counts.get(path) ?? { additions: 0, deletions: 0 };
}
