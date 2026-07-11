import { ArrowDown, ArrowUp, GitBranch, RefreshCw } from "lucide-react";
import { useApp } from "../store/app-store";
import type { GitFileStatus } from "../../../shared/ipc.ts";
import { cn } from "@/lib/utils";

const STATUS_GLYPH: Record<GitFileStatus["status"], { char: string; className: string }> = {
  modified: { char: "M", className: "text-amber-400" },
  added: { char: "A", className: "text-emerald-400" },
  deleted: { char: "D", className: "text-destructive" },
  renamed: { char: "R", className: "text-sky-400" },
  untracked: { char: "?", className: "text-muted-foreground" },
  conflicted: { char: "U", className: "text-destructive" },
};

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

function FileRow({ file, staged }: { file: GitFileStatus; staged: boolean }) {
  const showDiff = useApp((s) => s.showDiff);
  const { dir, name } = splitPath(file.path);
  const glyph = STATUS_GLYPH[file.status];

  const onClick = async () => {
    const patch = await window.cozy.git.diff(file.path, staged);
    showDiff({ path: file.path, patch, source: "git" });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-white/8"
    >
      <span className={cn("w-3 shrink-0 text-center font-mono text-xs font-semibold", glyph.className)}>
        {glyph.char}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="text-foreground/90">{name}</span>
        {dir ? <span className="text-muted-foreground/60"> {dir}</span> : null}
      </span>
      {file.additions > 0 || file.deletions > 0 ? (
        <span className="shrink-0 font-mono text-[11px]">
          <span className="text-emerald-400">+{file.additions}</span>{" "}
          <span className="text-destructive">-{file.deletions}</span>
        </span>
      ) : null}
    </button>
  );
}

function Group({ title, files, staged }: { title: string; files: GitFileStatus[]; staged: boolean }) {
  if (files.length === 0) return null;
  return (
    <section>
      <h3 className="mb-1 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title} · {files.length}
      </h3>
      <div className="flex flex-col">
        {files.map((f) => (
          <FileRow key={`${title}:${f.path}`} file={f} staged={staged} />
        ))}
      </div>
    </section>
  );
}

export function GitPane() {
  const status = useApp((s) => s.gitStatus);
  const refreshGit = useApp((s) => s.refreshGit);

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!status.isRepo) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Not a git repository.
      </div>
    );
  }

  const staged = status.files.filter((f) => f.staged);
  const changed = status.files.filter((f) => f.unstaged && f.status !== "untracked");
  const untracked = status.files.filter((f) => f.status === "untracked");
  const clean = status.files.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-sm">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground/90">{status.branch ?? "detached"}</span>
        {status.ahead > 0 ? (
          <span className="flex items-center text-xs text-muted-foreground">
            <ArrowUp className="size-3" />
            {status.ahead}
          </span>
        ) : null}
        {status.behind > 0 ? (
          <span className="flex items-center text-xs text-muted-foreground">
            <ArrowDown className="size-3" />
            {status.behind}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void refreshGit()}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
          title="Refresh"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      <div className="content-panel-scroll min-h-0 flex-1 overflow-auto p-2">
        {clean ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Working tree clean.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <Group title="Staged" files={staged} staged={true} />
            <Group title="Changed" files={changed} staged={false} />
            <Group title="Untracked" files={untracked} staged={false} />
          </div>
        )}
      </div>
    </div>
  );
}
