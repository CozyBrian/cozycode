import { Check, ChevronRight, CircleAlert, Copy, LoaderCircle, Terminal } from "lucide-react";
import { useId, useState } from "react";
import type { ToolItem } from "./tool-presentation.ts";
import {
  changeCounts,
  diffPayload,
  pendingLabel,
  record,
  resultPreview,
  shellOutput,
  stringArg,
  toolLabel,
} from "./tool-presentation.ts";
import { ToolDiff } from "./ToolDiff.tsx";
import { cn } from "@/lib/utils";

export function ToolCard({ item }: { item: ToolItem }) {
  if (item.toolName === "run_shell") return <ShellTool item={item} />;
  if ((item.toolName === "write_file" || item.toolName === "edit_file") && diffPayload(item)) {
    return <FileChangeTool item={item} />;
  }
  return <InlineTool item={item} />;
}

export function ContextToolGroup({ items }: { items: ToolItem[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const pending = items.some((item) => item.status === "running");
  const reads = items.filter((item) => item.toolName === "read_file").length;
  const searches = items.length - reads;
  const summary = [reads ? `${reads} ${reads === 1 ? "file" : "files"}` : "", searches ? `${searches} ${searches === 1 ? "search" : "searches"}` : ""]
    .filter(Boolean)
    .join(", ");

  return (
    <section className="rounded-lg border border-border/60 bg-card/30">
      <button
        type="button"
        onClick={() => !pending && setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={id}
        disabled={pending}
        className="group flex min-h-8 w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        {pending ? <LoaderCircle className="size-3.5 animate-spin text-primary" /> : <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />}
        <span className={cn("font-medium", pending ? "text-foreground" : "text-muted-foreground")}>{pending ? "Gathering context" : "Gathered context"}</span>
        <span className="truncate text-muted-foreground">{summary}</span>
      </button>
      {open ? (
        <div id={id} className="border-t border-border/50 px-3 py-1">
          {items.map((item) => <ContextTool key={item.id} item={item} />)}
        </div>
      ) : null}
    </section>
  );
}

function ContextTool({ item }: { item: ToolItem }) {
  return <div className="truncate py-1 text-xs text-muted-foreground">{item.status === "running" ? pendingLabel(item) : toolLabel(item)}</div>;
}

function InlineTool({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const running = item.status === "running";
  const error = item.status === "error";
  const denied = item.status === "denied";
  const hasDetails = error || (item.result !== undefined && item.toolName !== "read_file" && item.toolName !== "search");
  const label = running ? pendingLabel(item) : toolLabel(item);

  return (
    <section className={cn("rounded-lg", error && "border border-destructive/35 bg-destructive/5")}>
      <button
        type="button"
        onClick={() => hasDetails && setOpen((value) => !value)}
        aria-expanded={hasDetails ? open : undefined}
        aria-controls={hasDetails ? id : undefined}
        disabled={!hasDetails || running}
        className={cn("group flex min-h-8 w-full items-center gap-2 px-2 py-1 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", hasDetails && !running && "cursor-pointer", (!hasDetails || running) && "cursor-default")}
      >
        {running ? <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" /> : error ? <CircleAlert className="size-3.5 shrink-0 text-destructive" /> : denied ? <CircleAlert className="size-3.5 shrink-0 text-destructive" /> : <Check className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className={cn("truncate", error ? "text-destructive" : denied ? "text-muted-foreground line-through" : "text-muted-foreground")}>{label}</span>
        {denied ? <span className="ml-auto text-xs text-destructive">denied</span> : null}
        {hasDetails && !running ? <ChevronRight className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} /> : null}
      </button>
      {open ? <pre id={id} className="selectable mx-3 mb-2 max-h-60 overflow-auto border-l border-border pl-3 font-mono text-xs leading-relaxed text-muted-foreground">{resultPreview(item.result)}</pre> : null}
    </section>
  );
}

function ShellTool({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const id = useId();
  const running = item.status === "running";
  const result = record(item.result);
  const output = shellOutput(item.result);
  const command = stringArg(item.args, "command") ?? "";
  const canOpen = !running && item.status === "done";

  async function copy() {
    await navigator.clipboard?.writeText(`$ ${command}${output ? `\n\n${output}` : ""}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  if (!canOpen) return <InlineTool item={item} />;
  return (
    <section className="rounded-lg">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls={id} className="group flex min-h-8 w-full items-center gap-2 px-2 py-1 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium text-muted-foreground">Shell</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{command}</span>
        <ChevronRight className={cn("ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open ? <div id={id} className="relative mx-2 mb-2 rounded-md border border-border/70 bg-background/30"><button type="button" onClick={copy} className="absolute right-2 top-2 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100" aria-label="Copy command output">{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}</button><pre className="selectable max-h-60 overflow-auto whitespace-pre-wrap break-words p-3 pr-10 font-mono text-xs leading-relaxed text-foreground">$ {command}{output ? `\n\n${output}` : ""}</pre>{result?.timedOut === true ? <p className="border-t border-border/60 px-3 py-2 text-xs text-warning">Command timed out</p> : null}{result?.truncated === true ? <p className="border-t border-border/60 px-3 py-2 text-xs text-warning">Output truncated</p> : null}</div> : null}
    </section>
  );
}

function FileChangeTool({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const patch = diffPayload(item);
  if (!patch) return <InlineTool item={item} />;
  const path = stringArg(item.args, "path") ?? "file";
  const action = item.toolName === "write_file" ? "Wrote" : "Edited";
  const counts = changeCounts(patch);

  return (
    <section className="overflow-hidden rounded-lg border border-border/60 bg-card/30">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-controls={id} className="group flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Check className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium text-muted-foreground">{action}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{path}</span>
        <span className="ml-auto shrink-0 font-mono text-xs"><span className="text-emerald-400">+{counts.additions}</span> <span className="text-destructive">-{counts.deletions}</span></span>
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      </button>
      {open ? <div id={id} className="selectable border-t border-border/60 bg-background/20"><ToolDiff path={path} patch={patch} /></div> : null}
    </section>
  );
}
