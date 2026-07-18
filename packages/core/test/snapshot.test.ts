import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspaceSnapshotEngine, type WorkspaceSnapshotEngine } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace snapshots", () => {
  test("returns an explicit unsupported reason outside Git", async () => {
    const root = await temporaryRoot();
    const result = await openWorkspaceSnapshotEngine(root, { storageRoot: join(root, "store") });
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.reason).toBe("not-git-workspace");
  });

  test("captures and selectively restores exact dirty worktree state without changing the real index", async () => {
    const { repo, store } = await repository();
    await writeFile(join(repo, "modified.txt"), "base modified\n");
    await writeFile(join(repo, "deleted.txt"), "base deleted\n");
    await writeFile(join(repo, "renamed.txt"), "base renamed\n");
    await writeFile(join(repo, "mode.sh"), "#!/bin/sh\necho base\n");
    await chmod(join(repo, "mode.sh"), 0o644);
    await writeFile(join(repo, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);

    await writeFile(join(repo, "modified.txt"), "dirty baseline\n");
    await writeFile(join(repo, "staged.txt"), "staged version\n");
    await git(repo, ["add", "staged.txt"]);
    await writeFile(join(repo, "staged.txt"), "worktree after staging\n");
    await writeFile(join(repo, "untracked.txt"), "untracked baseline\n");
    const indexPath = (await git(repo, ["rev-parse", "--git-path", "index"])).trim();
    const indexBefore = await readFile(join(repo, indexPath));

    const engine = await openEngine(repo, store);
    const before = await engine.capture();
    expect(before.status).toBe("captured");
    if (before.status !== "captured") throw new Error(before.detail);
    expect(
      await git(repo, ["--git-dir", join(engine.storagePath, "objects.git"), "show-ref", before.snapshot.ref]),
    ).toContain(before.snapshot.tree);
    const concurrent = await Promise.all([engine.capture(), engine.capture()]);
    expect(concurrent.map((result) => result.status)).toEqual(["captured", "captured"]);
    expect(
      concurrent.map((result) => result.status === "captured" ? result.snapshot.tree : undefined),
    ).toEqual([before.snapshot.tree, before.snapshot.tree]);

    await writeFile(join(repo, "modified.txt"), "turn modified\n");
    await writeFile(join(repo, "created.txt"), "turn created\n");
    await unlink(join(repo, "deleted.txt"));
    await rename(join(repo, "renamed.txt"), join(repo, "moved.txt"));
    await writeFile(join(repo, "binary.bin"), Buffer.from([255, 0, 9, 8, 7]));
    await chmod(join(repo, "mode.sh"), 0o755);
    await symlink("modified.txt", join(repo, "link.txt"));

    const after = await engine.capture();
    expect(after.status).toBe("captured");
    if (after.status !== "captured") throw new Error(after.detail);
    expect(await readFile(join(repo, indexPath))).toEqual(indexBefore);

    const changes = await engine.changedPaths(before.snapshot, after.snapshot);
    expect(changes).toEqual([
      { path: "binary.bin", status: "modified" },
      { path: "created.txt", status: "added" },
      { path: "deleted.txt", status: "deleted" },
      { path: "link.txt", status: "added" },
      { path: "mode.sh", status: "modified" },
      { path: "modified.txt", status: "modified" },
      { path: "moved.txt", status: "added" },
      { path: "renamed.txt", status: "deleted" },
    ]);

    const checkpoint = await engine.checkpoint(before.snapshot, after.snapshot);
    expect(checkpoint.status).toBe("ready");
    if (checkpoint.status !== "ready") throw new Error(checkpoint.detail);
    const restored = await engine.restore(checkpoint.checkpoint);
    expect(restored).toEqual({ status: "restored", paths: changes.map((change) => change.path) });

    expect(await readFile(join(repo, "modified.txt"), "utf8")).toBe("dirty baseline\n");
    expect(await readFile(join(repo, "deleted.txt"), "utf8")).toBe("base deleted\n");
    expect(await readFile(join(repo, "renamed.txt"), "utf8")).toBe("base renamed\n");
    expect(await readFile(join(repo, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await readFile(join(repo, "staged.txt"), "utf8")).toBe("worktree after staging\n");
    expect(await readFile(join(repo, "untracked.txt"), "utf8")).toBe("untracked baseline\n");
    expect((await lstat(join(repo, "mode.sh"))).mode & 0o111).toBe(0);
    expect(await exists(join(repo, "created.txt"))).toBe(false);
    expect(await exists(join(repo, "moved.txt"))).toBe(false);
    expect(await exists(join(repo, "link.txt"))).toBe(false);
    expect(await readFile(join(repo, indexPath))).toEqual(indexBefore);
  });

  test("preflights every affected path before any restore mutation", async () => {
    const { repo, store } = await repository();
    await writeFile(join(repo, "a.txt"), "a0\n");
    await writeFile(join(repo, "b.txt"), "b0\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    const engine = await openEngine(repo, store);
    const before = await captured(engine);
    await writeFile(join(repo, "a.txt"), "a1\n");
    await writeFile(join(repo, "b.txt"), "b1\n");
    const after = await captured(engine);
    const checkpoint = await engine.checkpoint(before, after);
    if (checkpoint.status !== "ready") throw new Error(checkpoint.detail);

    await writeFile(join(repo, "b.txt"), "external edit\n");
    const result = await engine.restore(checkpoint.checkpoint);
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") expect(result.conflicts.map((item) => item.path)).toEqual(["b.txt"]);
    expect(await readFile(join(repo, "a.txt"), "utf8")).toBe("a1\n");
    expect(await readFile(join(repo, "b.txt"), "utf8")).toBe("external edit\n");
  });

  test("reports ignored omissions and skips oversized untracked files conservatively", async () => {
    const { repo, store } = await repository();
    await writeFile(join(repo, ".gitignore"), "ignored/\n");
    await mkdir(join(repo, "ignored"));
    await writeFile(join(repo, "ignored", "private.bin"), Buffer.alloc(32));
    await writeFile(join(repo, "large.bin"), Buffer.alloc(17));
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore"]);

    const engine = await openEngine(repo, store, 16);
    const result = await engine.capture();
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toBe("oversized-untracked");
      expect(result.paths).toEqual(["large.bin"]);
    }

    await unlink(join(repo, "large.bin"));
    const capturedResult = await engine.capture();
    expect(capturedResult.status).toBe("captured");
    if (capturedResult.status === "captured") {
      expect(capturedResult.omissions).toEqual([{ reason: "ignored-untracked", paths: ["ignored/"] }]);
    }
  });

  test("restores a symlink target and executable mode", async () => {
    const { repo, store } = await repository();
    await writeFile(join(repo, "one.txt"), "one");
    await writeFile(join(repo, "two.txt"), "two");
    await writeFile(join(repo, "run.sh"), "echo one\n");
    await chmod(join(repo, "run.sh"), 0o755);
    await symlink("one.txt", join(repo, "current"));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    const engine = await openEngine(repo, store);
    const before = await captured(engine);
    await unlink(join(repo, "current"));
    await symlink("two.txt", join(repo, "current"));
    await chmod(join(repo, "run.sh"), 0o644);
    const after = await captured(engine);
    const checkpoint = await engine.checkpoint(before, after);
    if (checkpoint.status !== "ready") throw new Error(checkpoint.detail);
    expect((await engine.restore(checkpoint.checkpoint)).status).toBe("restored");
    expect(await readlink(join(repo, "current"))).toBe("one.txt");
    expect((await lstat(join(repo, "run.sh"))).mode & 0o111).not.toBe(0);
  });

  test("restores raw bytes without applying checkout attributes", async () => {
    const { repo, store } = await repository();
    await writeFile(join(repo, ".gitattributes"), "raw.txt text eol=crlf\n");
    await writeFile(join(repo, "raw.txt"), Buffer.from("baseline\n"));
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    await writeFile(join(repo, "raw.txt"), Buffer.from("baseline\n"));
    const engine = await openEngine(repo, store);
    const before = await captured(engine);
    await writeFile(join(repo, "raw.txt"), Buffer.from("turn\r\n"));
    const after = await captured(engine);
    const checkpoint = await engine.checkpoint(before, after);
    if (checkpoint.status !== "ready") throw new Error(checkpoint.detail);
    expect((await engine.restore(checkpoint.checkpoint)).status).toBe("restored");
    expect(await readFile(join(repo, "raw.txt"))).toEqual(Buffer.from("baseline\n"));
  });

  test("restores file-directory type changes", async () => {
    const { repo, store } = await repository();
    await mkdir(join(repo, "shape"));
    await writeFile(join(repo, "shape", "nested.txt"), "nested\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    const engine = await openEngine(repo, store);
    const before = await captured(engine);
    await rm(join(repo, "shape"), { recursive: true });
    await writeFile(join(repo, "shape"), "flat\n");
    const after = await captured(engine);
    const checkpoint = await engine.checkpoint(before, after);
    if (checkpoint.status !== "ready") throw new Error(checkpoint.detail);
    expect((await engine.restore(checkpoint.checkpoint)).status).toBe("restored");
    expect((await lstat(join(repo, "shape"))).isDirectory()).toBe(true);
    expect(await readFile(join(repo, "shape", "nested.txt"), "utf8")).toBe("nested\n");
  });

  test("captures a tracked file replaced by a directory", async () => {
    const { repo, store } = await repository();
    await writeFile(join(repo, "shape"), "flat\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);
    const engine = await openEngine(repo, store);
    const before = await captured(engine);
    await unlink(join(repo, "shape"));
    await mkdir(join(repo, "shape"));
    await writeFile(join(repo, "shape", "nested.txt"), "nested\n");
    const after = await captured(engine);
    const checkpoint = await engine.checkpoint(before, after);
    if (checkpoint.status !== "ready") throw new Error(checkpoint.detail);
    expect((await engine.restore(checkpoint.checkpoint)).status).toBe("restored");
    expect((await lstat(join(repo, "shape"))).isFile()).toBe(true);
    expect(await readFile(join(repo, "shape"), "utf8")).toBe("flat\n");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cozycode-snapshot-"));
  roots.push(root);
  return root;
}

async function repository(): Promise<{ repo: string; store: string }> {
  const root = await temporaryRoot();
  const repo = join(root, "repo");
  const store = join(root, "snapshots");
  await mkdir(repo);
  await git(repo, ["init"]);
  await git(repo, ["config", "user.email", "snapshot@example.com"]);
  await git(repo, ["config", "user.name", "Snapshot Test"]);
  return { repo, store };
}

async function openEngine(
  repo: string,
  store: string,
  maxUntrackedBytes?: number,
): Promise<WorkspaceSnapshotEngine> {
  const result = await openWorkspaceSnapshotEngine(repo, { storageRoot: store, maxUntrackedBytes });
  if (result.status !== "ready") throw new Error(`${result.reason}: ${result.detail ?? ""}`);
  expect(result.storagePath.startsWith(await realpath(store))).toBe(true);
  expect(result.storagePath.startsWith(await realpath(repo))).toBe(false);
  return result.engine;
}

async function captured(engine: WorkspaceSnapshotEngine) {
  const result = await engine.capture();
  if (result.status !== "captured") throw new Error(`${result.reason}: ${result.detail ?? ""}`);
  return result.snapshot;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf8")));
    });
  });
}
