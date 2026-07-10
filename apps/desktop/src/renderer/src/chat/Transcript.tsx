import { useEffect, useRef } from "react";
import { useApp } from "../store/app-store";
import { ContextToolGroup, ToolCard } from "../components/ToolCard";
import { ReasoningCard } from "../components/ReasoningCard";
import { isContextTool, type ToolItem } from "../components/tool-presentation.ts";
import type { TranscriptItem } from "../transcript.ts";
import { Markdown } from "./Markdown";

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
      return (
        <div>
          <Markdown text={item.text} />
          {item.streaming && <span className="ml-0.5 animate-pulse text-primary">▍</span>}
        </div>
      );
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

export function Transcript() {
  const items = useApp((s) => s.items);
  const busy = useApp((s) => s.busy);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);

  useEffect(() => {
    if (followingRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, busy]);

  const rows: Array<TranscriptItem | ToolItem[]> = [];
  for (const item of items) {
    const previous = rows.at(-1);
    if (isContextTool(item) && Array.isArray(previous)) {
      previous.push(item);
    } else if (isContextTool(item)) {
      rows.push([item]);
    } else {
      rows.push(item);
    }
  }

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        const element = event.currentTarget;
        followingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex max-w-190 flex-col gap-4 px-6 py-6">
        {rows.map((row) => (
          Array.isArray(row)
            ? <ContextToolGroup key={row[0]?.id} items={row} />
            : <Row key={row.id} item={row} />
        ))}
        {busy && !items.some((i) => i.kind === "assistant" && i.streaming) && (
          <div className="text-sm text-muted-foreground">working…</div>
        )}
      </div>
    </div>
  );
}
