import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Clipboard, GitBranch, RefreshCw, Sparkles } from "lucide-react";
import { useApp } from "../store/app-store";
import type { GitCommitDraft, GitFileStatus, GitPullRequestDraft } from "../../../shared/ipc.ts";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

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
  const activeId = useApp((s) => s.activeId);
  const [commit, setCommit] = useState<GitCommitDraft | null>(null);
  const [pullRequest, setPullRequest] = useState<GitPullRequestDraft | null>(null);
  const [bases, setBases] = useState<string[]>([]);
  const [base, setBase] = useState("");
  const [loading, setLoading] = useState<"commit" | "pr" | "committing" | null>(null);
  const [confirmCommit, setConfirmCommit] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBases([]);
    setBase("");
    if (!activeId || !status?.isRepo) return () => { cancelled = true; };
    void window.cozy.git.pullRequestBases().then((next) => {
      if (cancelled) return;
      setBases(next);
      setBase(next[0] || "");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeId, status?.isRepo]);
  useEffect(() => { setCommit(null); setPullRequest(null); setConfirmCommit(false); }, [activeId]);

  const generateCommit = async () => {
    setLoading("commit"); setConfirmCommit(false);
    try { setCommit(await window.cozy.git.generateCommitDraft()); } catch (cause) { toast.error("Couldn't generate commit message", { description: message(cause) }); } finally { setLoading(null); }
  };
  const generatePullRequest = async () => {
    if (!base) return;
    setLoading("pr");
    try { setPullRequest(await window.cozy.git.generatePullRequestDraft(base)); } catch (cause) { toast.error("Couldn't generate PR description", { description: message(cause) }); } finally { setLoading(null); }
  };
  const commitDraft = async () => {
    if (!commit) return;
    setLoading("committing");
    try { await window.cozy.git.commit(commit); setCommit(null); setConfirmCommit(false); await refreshGit(); toast.success("Commit created"); } catch (cause) { toast.error("Couldn't create commit", { description: message(cause) }); } finally { setLoading(null); }
  };

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
        <div className="mb-4 rounded-lg border border-border/60 bg-white/3 p-2.5">
          <div className="flex gap-2">
            <button type="button" disabled={status.files.length === 0 || loading !== null} onClick={() => void generateCommit()} className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-white/8 px-2 py-1.5 text-xs font-medium hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40"><Sparkles className="size-3" />{loading === "commit" ? "Preparing…" : "Commit message"}</button>
            <button type="button" disabled={!base || loading !== null} onClick={() => void generatePullRequest()} className="flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md bg-white/8 px-2 py-1.5 text-xs font-medium hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40"><Sparkles className="size-3" />{loading === "pr" ? "Drafting…" : "PR description"}</button>
          </div>
          {bases.length > 0 ? <BaseBranchSelect base={base} bases={bases} onChange={setBase} /> : null}
        </div>
        {commit ? <CommitDraft draft={commit} onChange={setCommit} onCopy={() => void copy(`${commit.subject}\n${commit.body ? `\n${commit.body}` : ""}`).then(() => toast.success("Commit message copied")).catch((cause) => toast.error("Couldn't copy commit message", { description: message(cause) }))} onCommit={() => setConfirmCommit(true)} confirm={confirmCommit} onConfirm={() => void commitDraft()} onCancel={() => setConfirmCommit(false)} busy={loading === "committing"} /> : null}
        {pullRequest ? <PullRequestDraft draft={pullRequest} onChange={setPullRequest} onCopy={() => void copy(pullRequest.markdown).then(() => toast.success("PR description copied")).catch((cause) => toast.error("Couldn't copy PR description", { description: message(cause) }))} /> : null}
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

function CommitDraft({ draft, onChange, onCopy, onCommit, confirm, onConfirm, onCancel, busy }: { draft: GitCommitDraft; onChange(draft: GitCommitDraft): void; onCopy(): void; onCommit(): void; confirm: boolean; onConfirm(): void; onCancel(): void; busy: boolean }) {
  return <section className="mb-4 rounded-lg border border-border/60 bg-white/3 p-2.5"><div className="mb-2 flex items-center justify-between text-xs font-medium"><span>Commit message draft</span><button type="button" onClick={onCopy} title="Copy" className="rounded p-1 text-muted-foreground hover:bg-white/8 hover:text-foreground"><Clipboard className="size-3.5" /></button></div><input value={draft.subject} onChange={(event) => onChange({ ...draft, subject: event.target.value })} className="mb-2 h-8 w-full rounded border border-border/60 bg-background/40 px-2 text-xs" /><textarea value={draft.body} onChange={(event) => onChange({ ...draft, body: event.target.value })} rows={4} className="w-full resize-y rounded border border-border/60 bg-background/40 p-2 text-xs" />{confirm ? <div className="mt-2 flex items-center gap-2"><span className="flex-1 text-xs text-amber-400">Commit these staged changes?</span><button type="button" onClick={onCancel} className="rounded px-2 py-1 text-xs hover:bg-white/8">Cancel</button><button type="button" onClick={onConfirm} disabled={busy || !draft.subject.trim()} className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">{busy ? "Committing…" : "Commit"}</button></div> : <button type="button" onClick={onCommit} disabled={!draft.subject.trim()} className="mt-2 rounded bg-white/8 px-2 py-1 text-xs hover:bg-white/12 disabled:opacity-50">Commit…</button>}</section>;
}

function PullRequestDraft({ draft, onChange, onCopy }: { draft: GitPullRequestDraft; onChange(draft: GitPullRequestDraft): void; onCopy(): void }) {
  return <section className="mb-4 rounded-lg border border-border/60 bg-white/3 p-2.5"><div className="mb-2 flex items-center justify-between text-xs font-medium"><span>PR description · {draft.base}</span><button type="button" onClick={onCopy} title="Copy" className="rounded p-1 text-muted-foreground hover:bg-white/8 hover:text-foreground"><Clipboard className="size-3.5" /></button></div><textarea value={draft.markdown} onChange={(event) => onChange({ ...draft, markdown: event.target.value })} rows={10} className="w-full resize-y rounded border border-border/60 bg-background/40 p-2 text-xs" /></section>;
}

function BaseBranchSelect({ base, bases, onChange }: { base: string; bases: string[]; onChange(base: string): void }) {
  return <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="mt-2 flex h-7 w-full items-center gap-1 rounded border border-border/60 bg-background/40 px-1.5 text-left text-xs hover:bg-white/6"><span className="min-w-0 flex-1 truncate">{base || "Select base branch"}</span><ChevronDown className="size-3 shrink-0 text-muted-foreground" /></button></DropdownMenuTrigger><DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]"><DropdownMenuRadioGroup value={base} onValueChange={onChange}>{bases.map((item) => <DropdownMenuRadioItem key={item} value={item}>{item}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>;
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
async function copy(text: string): Promise<void> { await navigator.clipboard.writeText(text); }
