import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readlink,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

const DEFAULT_MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_REF_PREFIX = "refs/cozycode/snapshots";

export type SnapshotUnsupportedReason =
  | "workspace-unavailable"
  | "git-unavailable"
  | "not-git-workspace"
  | "bare-repository"
  | "storage-inside-worktree"
  | "invalid-options"
  | "snapshot-store-unavailable";

export type SnapshotSkippedReason =
  | "git-state-unavailable"
  | "non-utf8-path"
  | "oversized-untracked"
  | "unsupported-path-type"
  | "workspace-changed-during-capture"
  | "workspace-changed-during-fingerprint"
  | "workspace-diverged";

export interface WorkspaceSnapshotOptions {
  /** Private storage root. Defaults to the platform user cache directory. */
  storageRoot?: string;
  /** A larger untracked file skips the whole capture. Tracked files are never size-limited. */
  maxUntrackedBytes?: number;
}

export interface WorkspaceSnapshot {
  workspaceId: string;
  tree: string;
  ref: string;
}

export interface SnapshotOmission {
  reason: "ignored-untracked" | "ignored-query-unavailable";
  paths: string[];
}

export interface SnapshotChange {
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface PathFingerprint {
  path: string;
  kind: "absent" | "file" | "symlink" | "directory" | "other";
  mode?: "040000" | "100644" | "100755" | "120000";
  size?: number;
  digest: string;
}

export interface WorkspaceCheckpoint {
  workspaceId: string;
  target: WorkspaceSnapshot;
  current: WorkspaceSnapshot;
  changes: SnapshotChange[];
  fingerprints: PathFingerprint[];
}

export type OpenWorkspaceSnapshotResult =
  | {
      status: "ready";
      workspaceRoot: string;
      storagePath: string;
      engine: WorkspaceSnapshotEngine;
    }
  | {
      status: "unsupported";
      reason: SnapshotUnsupportedReason;
      detail?: string;
    };

export type CaptureSnapshotResult =
  | { status: "captured"; snapshot: WorkspaceSnapshot; omissions: SnapshotOmission[] }
  | { status: "skipped"; reason: SnapshotSkippedReason; paths: string[]; detail?: string };

export type FingerprintResult =
  | { status: "fingerprinted"; fingerprints: PathFingerprint[] }
  | { status: "skipped"; reason: SnapshotSkippedReason; paths: string[]; detail?: string };

export type CheckpointResult =
  | { status: "ready"; checkpoint: WorkspaceCheckpoint }
  | { status: "skipped"; reason: SnapshotSkippedReason; paths: string[]; detail?: string };

export type RestoreSnapshotResult =
  | { status: "restored"; paths: string[] }
  | {
      status: "conflict";
      conflicts: Array<{ path: string; expected: PathFingerprint; actual: PathFingerprint }>;
    }
  | { status: "skipped"; reason: SnapshotSkippedReason; paths: string[]; detail?: string };

interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: Buffer;
  error?: Error;
}

interface GitDigestResult {
  code: number | null;
  digest: string;
  size: number;
  stderr: Buffer;
  error?: Error;
}

interface CandidateSet {
  all: string[];
  tracked: Set<string>;
  untracked: Set<string>;
  gitlinks: Set<string>;
  ignored: string[] | undefined;
}

interface CapturedEntry {
  path: string;
  mode: "100644" | "100755" | "120000";
  oid: string;
}

interface TreeEntry {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

type FingerprintValue = Omit<PathFingerprint, "path">;

class SnapshotSkipError extends Error {
  constructor(
    readonly reason: SnapshotSkippedReason,
    readonly paths: string[],
    message?: string,
  ) {
    super(message ?? reason);
  }
}

const workspaceQueues = new Map<string, Promise<void>>();

/**
 * Detect a containing Git worktree and initialize its isolated snapshot store.
 * Detection and all later operations are rooted at Git's top-level worktree.
 */
export async function openWorkspaceSnapshotEngine(
  directory: string,
  options: WorkspaceSnapshotOptions = {},
): Promise<OpenWorkspaceSnapshotResult> {
  let input: string;
  try {
    input = await realpath(directory);
  } catch (error) {
    return { status: "unsupported", reason: "workspace-unavailable", detail: errorMessage(error) };
  }

  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], input, sourceGitEnvironment());
  if (inside.error && (inside.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { status: "unsupported", reason: "git-unavailable", detail: inside.error.message };
  }
  if (inside.code !== 0) {
    return {
      status: "unsupported",
      reason: "not-git-workspace",
      detail: inside.stderr.toString("utf8").trim() || undefined,
    };
  }
  if (inside.stdout.toString("utf8").trim() !== "true") {
    return { status: "unsupported", reason: "bare-repository" };
  }

  const topLevel = await runGit(["rev-parse", "--show-toplevel"], input, sourceGitEnvironment());
  if (topLevel.code !== 0) {
    return {
      status: "unsupported",
      reason: "not-git-workspace",
      detail: topLevel.stderr.toString("utf8").trim() || undefined,
    };
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(topLevel.stdout.toString("utf8").trim());
  } catch (error) {
    return { status: "unsupported", reason: "workspace-unavailable", detail: errorMessage(error) };
  }

  const workspaceId = createHash("sha256").update(workspaceRoot).digest("hex");
  const configuredStorageRoot = resolve(options.storageRoot ?? defaultStorageRoot());
  if (isInside(workspaceRoot, configuredStorageRoot)) {
    return { status: "unsupported", reason: "storage-inside-worktree" };
  }

  let storageRoot: string;
  try {
    await mkdir(configuredStorageRoot, { recursive: true, mode: 0o700 });
    storageRoot = await realpath(configuredStorageRoot);
  } catch (error) {
    return { status: "unsupported", reason: "snapshot-store-unavailable", detail: errorMessage(error) };
  }

  const storagePath = join(storageRoot, workspaceId);
  if (isInside(workspaceRoot, storagePath)) {
    return { status: "unsupported", reason: "storage-inside-worktree" };
  }

  const maxUntrackedBytes = options.maxUntrackedBytes ?? DEFAULT_MAX_UNTRACKED_BYTES;
  if (!Number.isSafeInteger(maxUntrackedBytes) || maxUntrackedBytes < 0) {
    return {
      status: "unsupported",
      reason: "invalid-options",
      detail: "maxUntrackedBytes must be a non-negative safe integer.",
    };
  }

  const engine = new GitWorkspaceSnapshotEngine(
    workspaceRoot,
    workspaceId,
    storagePath,
    maxUntrackedBytes,
  );
  try {
    await serializeWorkspace(workspaceRoot, () => engine.initialize());
  } catch (error) {
    return { status: "unsupported", reason: "snapshot-store-unavailable", detail: errorMessage(error) };
  }
  return { status: "ready", workspaceRoot, storagePath, engine };
}

export interface WorkspaceSnapshotEngine {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly storagePath: string;
  capture(): Promise<CaptureSnapshotResult>;
  changedPaths(from: WorkspaceSnapshot, to: WorkspaceSnapshot): Promise<SnapshotChange[]>;
  fingerprint(paths: readonly string[]): Promise<FingerprintResult>;
  checkpoint(target: WorkspaceSnapshot, current: WorkspaceSnapshot): Promise<CheckpointResult>;
  restore(checkpoint: WorkspaceCheckpoint): Promise<RestoreSnapshotResult>;
}

class GitWorkspaceSnapshotEngine implements WorkspaceSnapshotEngine {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly storagePath: string;

  private readonly gitDirectory: string;
  private readonly indexPath: string;
  private readonly maxUntrackedBytes: number;

  constructor(
    workspaceRoot: string,
    workspaceId: string,
    storagePath: string,
    maxUntrackedBytes: number,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.workspaceId = workspaceId;
    this.storagePath = storagePath;
    this.gitDirectory = join(storagePath, "objects.git");
    this.indexPath = join(storagePath, "index");
    this.maxUntrackedBytes = maxUntrackedBytes;
  }

  async initialize(): Promise<void> {
    await mkdir(this.storagePath, { recursive: true, mode: 0o700 });
    const probe = await runGit(
      ["--git-dir", this.gitDirectory, "rev-parse", "--git-dir"],
      this.workspaceRoot,
      sourceGitEnvironment(),
    );
    if (probe.code !== 0) {
      const initialized = await runGit(
        ["init", "--bare", this.gitDirectory],
        this.workspaceRoot,
        sourceGitEnvironment(),
      );
      requireGit(initialized, "initialize private snapshot repository");
    }
    for (const [key, value] of [
      ["core.autocrlf", "false"],
      ["core.filemode", "true"],
      ["core.symlinks", "true"],
      ["core.fsmonitor", "false"],
      ["gc.auto", "0"],
    ] as const) {
      requireGit(
        await runGit(
          ["--git-dir", this.gitDirectory, "config", key, value],
          this.workspaceRoot,
          sourceGitEnvironment(),
        ),
        `configure private snapshot repository (${key})`,
      );
    }
  }

  async capture(): Promise<CaptureSnapshotResult> {
    return serializeWorkspace(this.workspaceRoot, async () => {
      try {
        return await this.captureUnlocked();
      } catch (error) {
        if (error instanceof SnapshotSkipError) {
          return { status: "skipped", reason: error.reason, paths: error.paths, detail: error.message };
        }
        throw error;
      }
    });
  }

  async changedPaths(from: WorkspaceSnapshot, to: WorkspaceSnapshot): Promise<SnapshotChange[]> {
    return serializeWorkspace(this.workspaceRoot, () => this.changedPathsUnlocked(from, to));
  }

  /** Fingerprint live paths without following symlinks. Directory fingerprints include all descendants. */
  async fingerprint(paths: readonly string[]): Promise<FingerprintResult> {
    return serializeWorkspace(this.workspaceRoot, async () => {
      try {
        return { status: "fingerprinted", fingerprints: await this.fingerprintPathsUnlocked(paths) };
      } catch (error) {
        if (error instanceof SnapshotSkipError) {
          return { status: "skipped", reason: error.reason, paths: error.paths, detail: error.message };
        }
        throw error;
      }
    });
  }

  /**
   * Bind a pre-turn target to a post-turn snapshot. The affected live paths must
   * still exactly match the post-turn tree, otherwise checkpoint creation skips.
   */
  async checkpoint(target: WorkspaceSnapshot, current: WorkspaceSnapshot): Promise<CheckpointResult> {
    return serializeWorkspace(this.workspaceRoot, async () => {
      try {
        const changes = await this.changedPathsUnlocked(target, current);
        const paths = changes.map((change) => change.path);
        const fingerprints = await this.fingerprintPathsUnlocked(paths);
        const captured: PathFingerprint[] = [];
        for (const path of paths) captured.push(await this.snapshotFingerprint(current, path));
        const diverged = paths.filter((_, index) => !sameFingerprint(fingerprints[index]!, captured[index]!));
        if (diverged.length) {
          return {
            status: "skipped",
            reason: "workspace-diverged",
            paths: diverged,
            detail: "Affected paths no longer match the current snapshot.",
          };
        }
        return {
          status: "ready",
          checkpoint: {
            workspaceId: this.workspaceId,
            target,
            current,
            changes,
            fingerprints,
          },
        };
      } catch (error) {
        if (error instanceof SnapshotSkipError) {
          return { status: "skipped", reason: error.reason, paths: error.paths, detail: error.message };
        }
        throw error;
      }
    });
  }

  /** Restore only a checkpoint's affected paths after a mutation-free full preflight. */
  async restore(checkpoint: WorkspaceCheckpoint): Promise<RestoreSnapshotResult> {
    return serializeWorkspace(this.workspaceRoot, async () => {
      try {
        return await this.restoreUnlocked(checkpoint);
      } catch (error) {
        if (error instanceof SnapshotSkipError) {
          return { status: "skipped", reason: error.reason, paths: error.paths, detail: error.message };
        }
        throw error;
      }
    });
  }

  private async captureUnlocked(): Promise<CaptureSnapshotResult> {
    const candidates = await this.loadCandidates();
    const observations = new Map<string, string>();
    const pending: Array<{
      path: string;
      absolutePath: string;
      mode: "100644" | "100755" | "120000";
      stat: BigIntStats;
    }> = [];
    const oversized: string[] = [];
    const unsupported: string[] = [];

    for (const path of candidates.all) {
      const absolutePath = workspacePath(this.workspaceRoot, path);
      const stat = await lstatSafe(absolutePath);
      observations.set(path, stat ? statSignature(stat) : "absent");
      if (!stat) continue;
      if (stat.isDirectory()) {
        if (candidates.gitlinks.has(path) || !candidates.tracked.has(path)) unsupported.push(path);
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) {
        unsupported.push(path);
        continue;
      }
      if (
        candidates.untracked.has(path) &&
        !candidates.tracked.has(path) &&
        stat.isFile() &&
        stat.size > BigInt(this.maxUntrackedBytes)
      ) {
        oversized.push(path);
        continue;
      }
      pending.push({
        path,
        absolutePath,
        mode: stat.isSymbolicLink() ? "120000" : stat.mode & 0o111n ? "100755" : "100644",
        stat,
      });
    }

    if (oversized.length) {
      throw new SnapshotSkipError(
        "oversized-untracked",
        sortPaths(oversized),
        `Untracked files exceed the ${this.maxUntrackedBytes}-byte snapshot limit.`,
      );
    }
    if (unsupported.length) {
      throw new SnapshotSkipError(
        "unsupported-path-type",
        sortPaths(unsupported),
        "Gitlinks, nested repositories, directories reported as files, and special files are not snapshotted.",
      );
    }

    const entries = await this.hashEntries(pending);
    const after = await this.loadCandidates();
    if (!sameCandidates(candidates, after)) {
      throw new SnapshotSkipError(
        "workspace-changed-during-capture",
        changedCandidatePaths(candidates, after),
        "The workspace file set changed while it was being captured.",
      );
    }
    for (const [path, signature] of observations) {
      const stat = await lstatSafe(workspacePath(this.workspaceRoot, path));
      if ((stat ? statSignature(stat) : "absent") !== signature) {
        throw new SnapshotSkipError(
          "workspace-changed-during-capture",
          [path],
          "A workspace path changed while it was being captured.",
        );
      }
    }

    requireGit(await this.privateGit(["read-tree", "--empty"]), "reset private snapshot index");
    if (entries.length) {
      const indexInfo = Buffer.concat(
        entries.map((entry) => Buffer.from(`${entry.mode} ${entry.oid}\t${entry.path}\0`, "utf8")),
      );
      requireGit(
        await this.privateGit(["update-index", "--add", "-z", "--index-info"], indexInfo),
        "populate private snapshot index",
      );
    }
    await chmod(this.indexPath, 0o600).catch(() => undefined);
    const written = await this.privateGit(["write-tree"]);
    requireGit(written, "write snapshot tree");
    const tree = written.stdout.toString("ascii").trim();
    const ref = `${SNAPSHOT_REF_PREFIX}/${tree}`;
    requireGit(await this.privateGit(["update-ref", ref, tree]), "retain snapshot tree");

    const omissions: SnapshotOmission[] = candidates.ignored
      ? candidates.ignored.length
        ? [{ reason: "ignored-untracked", paths: candidates.ignored }]
        : []
      : [{ reason: "ignored-query-unavailable", paths: [] }];
    return {
      status: "captured",
      snapshot: { workspaceId: this.workspaceId, tree, ref },
      omissions,
    };
  }

  private async hashEntries(
    pending: Array<{
      path: string;
      absolutePath: string;
      mode: "100644" | "100755" | "120000";
      stat: BigIntStats;
    }>,
  ): Promise<CapturedEntry[]> {
    const entries: CapturedEntry[] = [];
    const regular = pending.filter((entry) => entry.mode !== "120000");
    for (let offset = 0; offset < regular.length; offset += 100) {
      const chunk = regular.slice(offset, offset + 100);
      for (const entry of chunk) {
        const before = await lstatSafe(entry.absolutePath);
        if (!before || statSignature(before) !== statSignature(entry.stat)) {
          throw new SnapshotSkipError("workspace-changed-during-capture", [entry.path]);
        }
      }
      const hashed = await this.privateGit([
        "hash-object",
        "-w",
        "--no-filters",
        "--",
        ...chunk.map((entry) => entry.absolutePath),
      ]);
      requireGit(hashed, "hash workspace files");
      const oids = hashed.stdout.toString("ascii").trim().split(/\r?\n/).filter(Boolean);
      if (oids.length !== chunk.length || oids.some((oid) => !/^[0-9a-f]+$/.test(oid))) {
        throw new SnapshotSkipError(
          "git-state-unavailable",
          chunk.map((entry) => entry.path),
          "Git returned an unexpected object list while hashing files.",
        );
      }
      for (let index = 0; index < chunk.length; index += 1) {
        const entry = chunk[index]!;
        const after = await lstatSafe(entry.absolutePath);
        if (!after || statSignature(after) !== statSignature(entry.stat)) {
          throw new SnapshotSkipError("workspace-changed-during-capture", [entry.path]);
        }
        entries.push({
          path: entry.path,
          mode: entry.mode,
          oid: oids[index]!,
        });
      }
    }

    for (const entry of pending.filter((item) => item.mode === "120000")) {
      const before = await lstatSafe(entry.absolutePath);
      if (!before || statSignature(before) !== statSignature(entry.stat)) {
        throw new SnapshotSkipError("workspace-changed-during-capture", [entry.path]);
      }
      const target = await readlink(entry.absolutePath, { encoding: "buffer" });
      const hashed = await this.privateGit(["hash-object", "-w", "--stdin"], target);
      requireGit(hashed, "hash workspace symlink");
      const after = await lstatSafe(entry.absolutePath);
      if (!after || statSignature(after) !== statSignature(entry.stat)) {
        throw new SnapshotSkipError("workspace-changed-during-capture", [entry.path]);
      }
      entries.push({
        path: entry.path,
        mode: "120000",
        oid: hashed.stdout.toString("ascii").trim(),
      });
    }
    return entries.sort((left, right) => comparePath(left.path, right.path));
  }

  private async loadCandidates(): Promise<CandidateSet> {
    const index = await this.sourceGit(["ls-files", "--cached", "-z"]);
    const staged = await this.sourceGit(["ls-files", "--stage", "-z"]);
    const untracked = await this.sourceGit(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (index.code !== 0 || staged.code !== 0 || untracked.code !== 0) {
      throw new SnapshotSkipError(
        "git-state-unavailable",
        [],
        [index.stderr, staged.stderr, untracked.stderr]
          .map((value) => value.toString("utf8").trim())
          .filter(Boolean)
          .join("\n"),
      );
    }

    const headCheck = await this.sourceGit(["rev-parse", "--verify", "HEAD^{tree}"]);
    const head = headCheck.code === 0
      ? await this.sourceGit(["ls-tree", "-r", "-z", "HEAD"])
      : undefined;
    if (head && head.code !== 0) {
      throw new SnapshotSkipError("git-state-unavailable", [], head.stderr.toString("utf8").trim());
    }

    let indexedPaths: string[];
    let stagedEntries: Array<{ mode: string; path: string }>;
    let headEntries: TreeEntry[];
    let untrackedPaths: string[];
    try {
      indexedPaths = decodeNulPaths(index.stdout);
      stagedEntries = parseIndexEntries(staged.stdout);
      headEntries = head ? parseTreeEntries(head.stdout) : [];
      untrackedPaths = decodeNulPaths(untracked.stdout);
    } catch (error) {
      throw new SnapshotSkipError("non-utf8-path", [], errorMessage(error));
    }

    const ignoredResult = await this.sourceGit([
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--no-empty-directory",
      "-z",
    ]);
    let ignored: string[] | undefined;
    if (ignoredResult.code === 0) {
      try {
        ignored = sortPaths(decodeNulPaths(ignoredResult.stdout));
      } catch {
        ignored = undefined;
      }
    }

    const tracked = new Set([...indexedPaths, ...headEntries.map((entry) => entry.path)]);
    const untrackedSet = new Set(untrackedPaths);
    const gitlinks = new Set([
      ...stagedEntries.filter((entry) => entry.mode === "160000").map((entry) => entry.path),
      ...headEntries.filter((entry) => entry.mode === "160000").map((entry) => entry.path),
    ]);
    const all = sortPaths([...new Set([...tracked, ...untrackedSet])]);
    for (const path of all) validateWorkspacePath(path);
    return { all, tracked, untracked: untrackedSet, gitlinks, ignored };
  }

  private async changedPathsUnlocked(
    from: WorkspaceSnapshot,
    to: WorkspaceSnapshot,
  ): Promise<SnapshotChange[]> {
    await this.validateSnapshot(from);
    await this.validateSnapshot(to);
    const result = await this.privateGit([
      "diff-tree",
      "--no-commit-id",
      "-r",
      "--name-status",
      "-z",
      "--no-renames",
      from.tree,
      to.tree,
    ]);
    requireGit(result, "compare snapshot trees");
    let fields: string[];
    try {
      fields = decodeNulPaths(result.stdout);
    } catch (error) {
      throw new SnapshotSkipError("non-utf8-path", [], errorMessage(error));
    }
    if (fields.length % 2 !== 0) {
      throw new SnapshotSkipError("git-state-unavailable", [], "Git returned a malformed tree diff.");
    }
    const changes: SnapshotChange[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      const code = fields[index]!;
      const path = fields[index + 1]!;
      validateWorkspacePath(path);
      changes.push({
        path,
        status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
      });
    }
    return changes.sort((left, right) => comparePath(left.path, right.path));
  }

  private async fingerprintPathsUnlocked(paths: readonly string[]): Promise<PathFingerprint[]> {
    const unique = sortPaths([...new Set(paths)]);
    for (const path of unique) validateWorkspacePath(path);
    const fingerprints: PathFingerprint[] = [];
    for (const path of unique) {
      await assertSafePathParents(this.workspaceRoot, path);
      fingerprints.push({
        path,
        ...(await fingerprintAbsolute(workspacePath(this.workspaceRoot, path), path)),
      });
    }
    return fingerprints;
  }

  private async snapshotFingerprint(snapshot: WorkspaceSnapshot, path: string): Promise<PathFingerprint> {
    const entry = await this.treeEntry(snapshot, path);
    if (!entry) return { path, kind: "absent", digest: "absent" };
    if (entry.mode === "040000") {
      const descendants = await this.treeDescendants(snapshot, path);
      const leaves: Array<{ relativePath: string; value: FingerprintValue }> = [];
      for (const child of descendants) {
        leaves.push({
          relativePath: child.path.slice(path.length + 1),
          value: await this.blobFingerprint(child, child.path),
        });
      }
      return { path, ...directoryFingerprint(leaves) };
    }
    return { path, ...(await this.blobFingerprint(entry, path)) };
  }

  private async blobFingerprint(entry: TreeEntry, path: string): Promise<FingerprintValue> {
    if (entry.mode === "160000" || entry.type !== "blob") {
      throw new SnapshotSkipError("unsupported-path-type", [path], "Gitlinks cannot be fingerprinted.");
    }
    const content = await this.privateGitDigest(["cat-file", "blob", entry.oid]);
    requireGitDigest(content, `read snapshot blob ${path}`);
    if (entry.mode === "120000") {
      return { kind: "symlink", mode: "120000", size: content.size, digest: content.digest };
    }
    return {
      kind: "file",
      mode: entry.mode === "100755" ? "100755" : "100644",
      size: content.size,
      digest: content.digest,
    };
  }

  private async restoreUnlocked(checkpoint: WorkspaceCheckpoint): Promise<RestoreSnapshotResult> {
    if (checkpoint.workspaceId !== this.workspaceId) throw new Error("Checkpoint belongs to another workspace.");
    await this.validateSnapshot(checkpoint.target);
    await this.validateSnapshot(checkpoint.current);

    const actualChanges = await this.changedPathsUnlocked(checkpoint.target, checkpoint.current);
    if (JSON.stringify(actualChanges) !== JSON.stringify(checkpoint.changes)) {
      throw new Error("Checkpoint change list does not match its snapshots.");
    }
    const paths = actualChanges.map((change) => change.path);
    if (
      checkpoint.fingerprints.length !== paths.length ||
      checkpoint.fingerprints.some((fingerprint, index) => fingerprint.path !== paths[index])
    ) {
      throw new Error("Checkpoint fingerprints do not cover its deterministic change list.");
    }

    // Complete every live filesystem read before the first worktree mutation.
    const actual = await this.fingerprintPathsUnlocked(paths);
    const conflicts = checkpoint.fingerprints.flatMap((expected, index) =>
      sameFingerprint(expected, actual[index]!)
        ? []
        : [{ path: expected.path, expected, actual: actual[index]! }],
    );
    if (conflicts.length) return { status: "conflict", conflicts };
    if (!paths.length) return { status: "restored", paths: [] };

    const targetEntries: Array<TreeEntry | undefined> = [];
    for (const path of paths) targetEntries.push(await this.treeEntry(checkpoint.target, path));
    const removals = new Set<string>();
    const restoreEntries = new Map<string, TreeEntry>();
    const affected = new Set(paths);
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index]!;
      const target = targetEntries[index];
      const current = actual[index]!;
      if (!target) {
        if (current.kind !== "absent") removals.add(path);
        continue;
      }
      if (target.mode === "040000") {
        if (current.kind !== "absent" && current.kind !== "directory") removals.add(path);
        for (const child of await this.treeDescendants(checkpoint.target, path)) {
          if (child.mode === "160000") {
            throw new SnapshotSkipError("unsupported-path-type", [child.path], "Gitlinks cannot be restored.");
          }
          if (affected.has(child.path)) restoreEntries.set(child.path, child);
        }
        continue;
      }
      if (target.mode === "160000") {
        throw new SnapshotSkipError("unsupported-path-type", [path], "Gitlinks cannot be restored.");
      }
      if (current.kind === "directory") removals.add(path);
      restoreEntries.set(path, target);
    }

    // Stage raw blobs outside the worktree so attributes and smudge filters cannot alter them.
    const staging = await mkdtemp(join(this.storagePath, "restore-"));
    const prepared = new Map<
      string,
      { file?: string; symlinkTarget?: Buffer; mode: "100644" | "100755" | "120000" }
    >();
    try {
      let index = 0;
      for (const [path, entry] of [...restoreEntries].sort(([left], [right]) => comparePath(left, right))) {
        if (entry.type !== "blob" || !["100644", "100755", "120000"].includes(entry.mode)) {
          throw new SnapshotSkipError("unsupported-path-type", [path], `Unsupported Git mode ${entry.mode}.`);
        }
        if (entry.mode === "120000") {
          const content = await this.privateGit(["cat-file", "blob", entry.oid]);
          requireGit(content, `stage snapshot symlink ${path}`);
          prepared.set(path, { symlinkTarget: content.stdout, mode: "120000" });
          continue;
        }
        const file = join(staging, String(index++));
        requireGit(
          await this.privateGitFile(["cat-file", "blob", entry.oid], file),
          `stage snapshot file ${path}`,
        );
        const mode = entry.mode === "100755" ? "100755" : "100644";
        await chmod(file, mode === "100755" ? 0o755 : 0o644);
        prepared.set(path, { file, mode });
      }

      for (const path of restoreEntries.keys()) removals.add(path);
      for (const path of paths) await assertSafePathParents(this.workspaceRoot, path);
      for (const path of [...removals].sort(
        (left, right) => pathDepth(left) - pathDepth(right) || comparePath(left, right),
      )) {
        await removeWorkspacePath(workspacePath(this.workspaceRoot, path));
      }
      for (const [path, entry] of [...prepared].sort(([left], [right]) => comparePath(left, right))) {
        const destination = workspacePath(this.workspaceRoot, path);
        await mkdir(dirname(destination), { recursive: true });
        if (entry.mode === "120000") {
          await symlink(entry.symlinkTarget!, destination);
          continue;
        }
        await copyFile(entry.file!, destination);
        await chmod(destination, entry.mode === "100755" ? 0o755 : 0o644);
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    const restored = await this.fingerprintPathsUnlocked(paths);
    const expected: PathFingerprint[] = [];
    for (const path of paths) expected.push(await this.snapshotFingerprint(checkpoint.target, path));
    const failed = paths.filter((_, index) => !sameFingerprint(restored[index]!, expected[index]!));
    if (failed.length) {
      throw new Error(`Snapshot restore verification failed for: ${failed.join(", ")}`);
    }
    return { status: "restored", paths };
  }

  private async treeEntry(snapshot: WorkspaceSnapshot, path: string): Promise<TreeEntry | undefined> {
    validateWorkspacePath(path);
    const result = await this.privateGit(["--literal-pathspecs", "ls-tree", "-z", snapshot.tree, "--", path]);
    requireGit(result, `inspect snapshot path ${path}`);
    const entries = parseTreeEntries(result.stdout);
    return entries.find((entry) => entry.path === path);
  }

  private async treeDescendants(snapshot: WorkspaceSnapshot, path: string): Promise<TreeEntry[]> {
    const result = await this.privateGit([
      "--literal-pathspecs",
      "ls-tree",
      "-r",
      "-z",
      snapshot.tree,
      "--",
      path,
    ]);
    requireGit(result, `inspect snapshot directory ${path}`);
    return parseTreeEntries(result.stdout).filter((entry) => entry.path.startsWith(`${path}/`));
  }

  private async validateSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    if (snapshot.workspaceId !== this.workspaceId) throw new Error("Snapshot belongs to another workspace.");
    if (!/^[0-9a-f]+$/.test(snapshot.tree)) throw new Error("Snapshot tree ID is invalid.");
    const result = await this.privateGit(["cat-file", "-e", `${snapshot.tree}^{tree}`]);
    requireGit(result, `resolve snapshot tree ${snapshot.tree}`);
  }

  private sourceGit(args: string[]): Promise<GitResult> {
    return runGit(args, this.workspaceRoot, sourceGitEnvironment());
  }

  private privateGit(args: string[], stdin?: Buffer): Promise<GitResult> {
    return runGit(args, this.workspaceRoot, {
      ...sourceGitEnvironment(),
      GIT_DIR: this.gitDirectory,
      GIT_WORK_TREE: this.workspaceRoot,
      GIT_INDEX_FILE: this.indexPath,
      GIT_LITERAL_PATHSPECS: "1",
    }, stdin);
  }

  private privateGitDigest(args: string[]): Promise<GitDigestResult> {
    return runGitDigest(args, this.workspaceRoot, {
      ...sourceGitEnvironment(),
      GIT_DIR: this.gitDirectory,
      GIT_WORK_TREE: this.workspaceRoot,
      GIT_INDEX_FILE: this.indexPath,
      GIT_LITERAL_PATHSPECS: "1",
    });
  }

  private privateGitFile(args: string[], destination: string): Promise<GitResult> {
    return runGitToFile(
      args,
      this.workspaceRoot,
      {
        ...sourceGitEnvironment(),
        GIT_DIR: this.gitDirectory,
        GIT_WORK_TREE: this.workspaceRoot,
        GIT_INDEX_FILE: this.indexPath,
        GIT_LITERAL_PATHSPECS: "1",
      },
      destination,
    );
  }
}

async function fingerprintAbsolute(absolutePath: string, displayPath: string): Promise<FingerprintValue> {
  const stat = await lstatSafe(absolutePath);
  if (!stat) return { kind: "absent", digest: "absent" };
  if (stat.isFile()) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
    const after = await lstatSafe(absolutePath);
    if (!after || statSignature(after) !== statSignature(stat)) {
      throw new SnapshotSkipError("workspace-changed-during-fingerprint", [displayPath]);
    }
    return {
      kind: "file",
      mode: stat.mode & 0o111n ? "100755" : "100644",
      size: Number(stat.size),
      digest: hash.digest("hex"),
    };
  }
  if (stat.isSymbolicLink()) {
    const target = await readlink(absolutePath, { encoding: "buffer" });
    const after = await lstatSafe(absolutePath);
    if (!after || statSignature(after) !== statSignature(stat)) {
      throw new SnapshotSkipError("workspace-changed-during-fingerprint", [displayPath]);
    }
    return {
      kind: "symlink",
      mode: "120000",
      size: target.length,
      digest: createHash("sha256").update(target).digest("hex"),
    };
  }
  if (stat.isDirectory()) {
    return directoryFingerprint(await fingerprintDirectory(absolutePath, displayPath, stat));
  }
  return {
    kind: "other",
    size: Number(stat.size),
    digest: createHash("sha256").update(statSignature(stat)).digest("hex"),
  };
}

async function fingerprintDirectory(
  absolutePath: string,
  displayPath: string,
  stat: BigIntStats,
): Promise<Array<{ relativePath: string; value: FingerprintValue }>> {
  const beforeNames = sortPaths(await readdir(absolutePath));
  const leaves: Array<{ relativePath: string; value: FingerprintValue }> = [];
  for (const name of beforeNames) {
    const child = join(absolutePath, name);
    const childStat = await lstatSafe(child);
    if (!childStat) throw new SnapshotSkipError("workspace-changed-during-fingerprint", [`${displayPath}/${name}`]);
    if (childStat.isDirectory()) {
      const nested = await fingerprintDirectory(child, `${displayPath}/${name}`, childStat);
      leaves.push(...nested.map((leaf) => ({ relativePath: `${name}/${leaf.relativePath}`, value: leaf.value })));
    } else {
      leaves.push({
        relativePath: name,
        value: await fingerprintAbsolute(child, `${displayPath}/${name}`),
      });
    }
  }
  const after = await lstatSafe(absolutePath);
  const afterNames = sortPaths(await readdir(absolutePath).catch(() => []));
  if (
    !after ||
    statSignature(after) !== statSignature(stat) ||
    JSON.stringify(beforeNames) !== JSON.stringify(afterNames)
  ) {
    throw new SnapshotSkipError("workspace-changed-during-fingerprint", [displayPath]);
  }
  return leaves;
}

function directoryFingerprint(
  leaves: Array<{ relativePath: string; value: FingerprintValue }>,
): FingerprintValue {
  const hash = createHash("sha256");
  for (const leaf of leaves.sort((left, right) => comparePath(left.relativePath, right.relativePath))) {
    const path = Buffer.from(leaf.relativePath, "utf8");
    const value = Buffer.from(JSON.stringify(leaf.value), "utf8");
    hash.update(`${path.length}:`);
    hash.update(path);
    hash.update(`${value.length}:`);
    hash.update(value);
  }
  return { kind: "directory", mode: "040000", size: leaves.length, digest: hash.digest("hex") };
}

function parseTreeEntries(buffer: Buffer): TreeEntry[] {
  let records: string[];
  try {
    records = decodeNulPaths(buffer);
  } catch (error) {
    throw new SnapshotSkipError("non-utf8-path", [], errorMessage(error));
  }
  return records.map((record) => {
    const tab = record.indexOf("\t");
    const metadata = tab >= 0 ? record.slice(0, tab).split(" ") : [];
    const path = tab >= 0 ? record.slice(tab + 1) : "";
    if (metadata.length !== 3 || !path) {
      throw new SnapshotSkipError("git-state-unavailable", [], "Git returned a malformed tree entry.");
    }
    validateWorkspacePath(path);
    return { mode: metadata[0]!, type: metadata[1]!, oid: metadata[2]!, path };
  });
}

function parseIndexEntries(buffer: Buffer): Array<{ mode: string; path: string }> {
  let records: string[];
  try {
    records = decodeNulPaths(buffer);
  } catch (error) {
    throw new SnapshotSkipError("non-utf8-path", [], errorMessage(error));
  }
  return records.map((record) => {
    const tab = record.indexOf("\t");
    const metadata = tab >= 0 ? record.slice(0, tab).split(" ") : [];
    const path = tab >= 0 ? record.slice(tab + 1) : "";
    if (metadata.length !== 3 || !path) {
      throw new SnapshotSkipError("git-state-unavailable", [], "Git returned a malformed index entry.");
    }
    validateWorkspacePath(path);
    return { mode: metadata[0]!, path };
  });
}

function decodeNulPaths(buffer: Buffer): string[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const output: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) output.push(decoder.decode(buffer.subarray(start, index)));
    start = index + 1;
  }
  if (start !== buffer.length) throw new Error("NUL-terminated Git output was truncated.");
  return output;
}

function validateWorkspacePath(path: string): void {
  const parts = path.split("/");
  if (
    !path ||
    path.includes("\0") ||
    isAbsolute(path) ||
    parts.some((part) => !part || part === "." || part === "..") ||
    parts[0]?.toLowerCase() === ".git"
  ) {
    throw new Error(`Unsafe snapshot path: ${JSON.stringify(path)}`);
  }
}

function workspacePath(root: string, path: string): string {
  validateWorkspacePath(path);
  const result = resolve(root, ...path.split("/"));
  if (!isInside(root, result)) throw new Error(`Snapshot path escapes the workspace: ${path}`);
  return result;
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function lstatSafe(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

async function assertSafePathParents(root: string, path: string): Promise<void> {
  const parts = path.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = await lstatSafe(current);
    if (!stat || !stat.isDirectory()) {
      if (stat?.isSymbolicLink()) {
        throw new SnapshotSkipError(
          "workspace-diverged",
          [path],
          "An intermediate path is a symlink, so the path cannot be restored safely.",
        );
      }
      return;
    }
  }
}

function statSignature(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

async function removeWorkspacePath(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
}

function sameCandidates(left: CandidateSet, right: CandidateSet): boolean {
  return (
    JSON.stringify(left.all) === JSON.stringify(right.all) &&
    JSON.stringify(sortPaths([...left.tracked])) === JSON.stringify(sortPaths([...right.tracked])) &&
    JSON.stringify(sortPaths([...left.untracked])) === JSON.stringify(sortPaths([...right.untracked])) &&
    JSON.stringify(sortPaths([...left.gitlinks])) === JSON.stringify(sortPaths([...right.gitlinks])) &&
    JSON.stringify(left.ignored) === JSON.stringify(right.ignored)
  );
}

function changedCandidatePaths(left: CandidateSet, right: CandidateSet): string[] {
  const leftPaths = [...left.all, ...(left.ignored ?? [])];
  const rightPaths = [...right.all, ...(right.ignored ?? [])];
  const leftSet = new Set(leftPaths);
  const rightSet = new Set(rightPaths);
  return sortPaths([
    ...leftPaths.filter((path) => !rightSet.has(path)),
    ...rightPaths.filter((path) => !leftSet.has(path)),
  ]);
}

function sameFingerprint(left: PathFingerprint, right: PathFingerprint): boolean {
  return (
    left.path === right.path &&
    left.kind === right.kind &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.digest === right.digest
  );
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function sortPaths(paths: string[]): string[] {
  return paths.sort(comparePath);
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  delete environment.GIT_INDEX_FILE;
  return environment;
}

function runGit(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  stdin?: Buffer,
): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let error: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (value) => {
      error = value;
    });
    child.on("close", (code) => {
      resolvePromise({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error });
    });
    child.stdin.end(stdin);
  });
}

function runGitDigest(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<GitDigestResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const hash = createHash("sha256");
    const stderr: Buffer[] = [];
    let size = 0;
    let error: Error | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (value) => {
      error = value;
    });
    child.on("close", (code) => {
      resolvePromise({
        code,
        digest: hash.digest("hex"),
        size,
        stderr: Buffer.concat(stderr),
        error,
      });
    });
  });
}

async function runGitToFile(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  destination: string,
): Promise<GitResult> {
  const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  let error: Error | undefined;
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.on("error", (value) => {
    error = value;
  });
  const closed = new Promise<number | null>((resolvePromise) => child.on("close", resolvePromise));
  const streamed = pipeline(child.stdout, createWriteStream(destination, { mode: 0o600 })).catch((value) => {
    error = value instanceof Error ? value : new Error(String(value));
    child.kill();
  });
  const [code] = await Promise.all([closed, streamed]);
  return { code, stdout: Buffer.alloc(0), stderr: Buffer.concat(stderr), error };
}

function requireGit(result: GitResult, action: string): void {
  if (result.code === 0) return;
  const detail = result.stderr.toString("utf8").trim() || result.error?.message || `exit ${result.code}`;
  throw new Error(`Could not ${action}: ${detail}`);
}

function requireGitDigest(result: GitDigestResult, action: string): void {
  if (result.code === 0) return;
  const detail = result.stderr.toString("utf8").trim() || result.error?.message || `exit ${result.code}`;
  throw new Error(`Could not ${action}: ${detail}`);
}

function serializeWorkspace<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
  const previous = workspaceQueues.get(workspace) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  workspaceQueues.set(workspace, queued);
  return previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => {
      release();
      if (workspaceQueues.get(workspace) === queued) workspaceQueues.delete(workspace);
    });
}

function defaultStorageRoot(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "CozyCode", "snapshots");
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "CozyCode", "snapshots");
  }
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "cozycode", "snapshots");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
