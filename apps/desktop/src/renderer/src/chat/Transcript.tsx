import { useEffect, useRef, useState, type UIEvent, type WheelEvent } from "react";
import { ArrowLeft, Check, Copy } from "lucide-react";
import { pickSpinnerVerb } from "@cozycode/commands";
import { useApp } from "../store/app-store";
import { ContextToolGroup, ToolCard } from "../components/ToolCard";
import { ReasoningCard } from "../components/ReasoningCard";
import { TextShimmer } from "../components/TextShimmer";
import { isContextTool, type ToolItem } from "../components/tool-presentation.ts";
import type { TranscriptItem } from "../transcript.ts";
import { Markdown } from "./Markdown";

/** Group context reads/searches and render a list of transcript items. */
function renderRows(items: TranscriptItem[]) {
  const rows: Array<TranscriptItem | ToolItem[]> = [];
  for (const item of items) {
    const previous = rows.at(-1);
    if (isContextTool(item) && Array.isArray(previous)) previous.push(item);
    else if (isContextTool(item)) rows.push([item]);
    else rows.push(item);
  }
  return rows.map((row) =>
    Array.isArray(row) ? (
      <ContextToolGroup key={row[0]?.id} items={row} />
    ) : (
      <Row key={row.id} item={row} />
    ),
  );
}

/** Find a subagent block by its child session id across the transcript. */
function findSubagent(items: TranscriptItem[], sessionId: string) {
  for (const item of items) {
    if (item.kind === "tool" && item.subagent?.sessionId === sessionId) return item.subagent;
  }
  return null;
}

function Row({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="selectable max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-cozy-600/30 px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
            {item.text}
          </div>
        </div>
      );
    case "assistant":
      return <AssistantMessage text={item.text} />;
    case "tool":
      return <ToolCard item={item} />;
    case "reasoning":
      return <ReasoningCard item={item} />;
    case "error":
      return (
        <div className="selectable rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          {item.text}
        </div>
      );
    case "system":
      return (
        <div className="selectable text-center text-xs text-muted-foreground">{item.text}</div>
      );
  }
}

function AssistantMessage({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <Markdown text={text} />
      <div className="mt-1 flex justify-start">
        <button
          type="button"
          onClick={() => void copy()}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          aria-label="Copy message as Markdown"
          title="Copy message as Markdown"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}

export function Transcript() {
  const items = useApp((s) => s.items);
  const busy = useApp((s) => s.busy);
  const activeId = useApp((s) => s.activeId);
  const subagentView = useApp((s) => s.subagentView);
  const exitSubagent = useApp((s) => s.exitSubagent);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const [verb, setVerb] = useState(() => pickSpinnerVerb());

  useEffect(() => {
    if (!busy) return;
    setVerb(pickSpinnerVerb());
    const interval = setInterval(() => setVerb(pickSpinnerVerb()), 4500);
    return () => clearInterval(interval);
  }, [busy]);

  const subagent = subagentView ? findSubagent(items, subagentView) : null;

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    followingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) followingRef.current = false;
  };

  useEffect(() => {
    followingRef.current = true;
  }, [activeId, subagentView]);

  useEffect(() => {
    if (followingRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [activeId, items, busy, subagentView, subagent?.items]);

  // Read-only drill-in view of a subagent (the live parent turn keeps running).
  if (subagentView && subagent) {
    return (
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-190 flex-col gap-4 px-6 py-6">
          <div className="flex items-center gap-2 border-b border-border/60 pb-3">
            <button
              type="button"
              onClick={exitSubagent}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            >
              <ArrowLeft className="size-4" />
              Back
            </button>
            <span className="text-sm font-medium text-foreground">{subagent.agent}</span>
            <span className="truncate text-sm text-muted-foreground">{subagent.description}</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {subagent.status === "running" ? "running…" : subagent.status === "error" ? "failed" : "completed"}
            </span>
          </div>
          {renderRows(subagent.items)}
          {subagent.status === "running" && (
            <TextShimmer className="text-sm">Working…</TextShimmer>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-190 flex-col gap-4 px-6 py-6">
        {renderRows(items)}
        {busy && !items.some((i) => i.kind === "assistant" && i.streaming) && (
          <TextShimmer className="text-sm">{`${verb}…`}</TextShimmer>
        )}
      </div>
    </div>
  );
}
