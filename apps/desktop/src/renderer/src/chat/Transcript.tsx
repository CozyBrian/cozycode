import { useEffect, useRef } from "react";
import { useApp } from "../store/app-store";
import { ToolCard } from "../components/ToolCard";
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items, busy]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 px-6 py-6">
        {items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
        {busy && !items.some((i) => i.kind === "assistant" && i.streaming) && (
          <div className="text-sm text-muted-foreground">working…</div>
        )}
      </div>
    </div>
  );
}
