import { useState } from "react";
import { ChevronRight, Terminal } from "lucide-react";
import type { TranscriptItem } from "../transcript.ts";
import { cn } from "@/lib/utils";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

const STATUS: Record<ToolItem["status"], { label: string; dot: string }> = {
  running: { label: "running", dot: "bg-warning animate-pulse" },
  done: { label: "done", dot: "bg-emerald-400" },
  error: { label: "error", dot: "bg-destructive" },
  denied: { label: "denied", dot: "bg-destructive" },
};

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const status = STATUS[item.status];

  return (
    <div className="rounded-xl border border-border bg-card/60 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight
          className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <Terminal className="size-3.5 text-muted-foreground" />
        <span className="font-mono text-[13px] text-foreground">{item.toolName}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", status.dot)} />
          {status.label}
        </span>
      </button>
      {open && (
        <div className="selectable border-t border-border/60 px-3 py-2 font-mono text-xs">
          <pre className="overflow-x-auto whitespace-pre-wrap text-muted-foreground">
            {compact(item.args)}
          </pre>
          {item.result !== undefined && (
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap border-t border-border/40 pt-2 text-muted-foreground">
              {compact(item.result)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function compact(value: unknown): string {
  const s = JSON.stringify(value, null, 2) ?? String(value);
  return s.length > 1200 ? s.slice(0, 1200) + "\n…" : s;
}
