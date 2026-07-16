import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
  type WheelEvent,
} from "react";
import { ArrowLeft, Check, Copy, GitFork, Pencil } from "lucide-react";
import { pickSpinnerVerb } from "@cozycode/commands";
import {
  Virtuoso,
  type StateSnapshot,
  type VirtuosoHandle,
} from "react-virtuoso";
import { useApp } from "../store/app-store";
import { ContextToolGroup, ToolCard } from "../components/ToolCard";
import { ReasoningCard } from "../components/ReasoningCard";
import { TextShimmer } from "../components/TextShimmer";
import type { TranscriptItem } from "../transcript.ts";
import { Markdown } from "./Markdown";
import { transcriptRows, type TranscriptRow } from "./transcript-rows.ts";

type DisplayRow =
  | TranscriptRow
  | {
      key: string;
      kind: "subagent-header";
      agent: string;
      description: string;
      status: "running" | "done" | "error";
    }
  | { key: string; kind: "status"; text: string };

const routeSnapshots = new Map<string, StateSnapshot>();
const routeFollowing = new Map<string, boolean>();

/** Find a subagent block by its child session id across the transcript. */
function findSubagent(items: TranscriptItem[], sessionId: string) {
  for (const item of items) {
    if (item.kind === "tool" && item.subagent?.sessionId === sessionId) return item.subagent;
  }
  return null;
}

const Row = memo(function Row({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} />;
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
});

function UserMessage({ item }: { item: Extract<TranscriptItem, { kind: "user" }> }) {
  const [copied, setCopied] = useState(false);
  const running = useApp((state) => state.running);
  const isTopLevel = useApp((state) => state.subagentView === null);
  const forkFromTurn = useApp((state) => state.forkFromTurn);
  const setEditingUserTurn = useApp((state) => state.setEditingUserTurn);

  const copy = async () => {
    await navigator.clipboard.writeText(item.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group flex flex-col items-end">
      <div className="selectable max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-cozy-600/30 px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
        {item.text}
      </div>
      <div className="mt-1 flex h-7 items-center justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={() => void copy()}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
          aria-label="Copy user message"
          title="Copy"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
        {isTopLevel && item.turnId ? (
          <>
            <button
              type="button"
              disabled={running}
              onClick={() => void forkFromTurn(item.turnId!, item.text)}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-35"
              aria-label="Fork from this message"
              title="Fork from here"
            >
              <GitFork className="size-3.5" />
            </button>
            <button
              type="button"
              disabled={running}
              onClick={() => setEditingUserTurn({ turnId: item.turnId!, text: item.text })}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground disabled:opacity-35"
              aria-label="Edit user message"
              title="Edit and continue"
            >
              <Pencil className="size-3.5" />
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
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

function sameDisplayRow(previous: { row: DisplayRow }, next: { row: DisplayRow }) {
  if (previous.row === next.row) return true;
  if (previous.row.kind !== next.row.kind || previous.row.key !== next.row.key) return false;
  if (previous.row.kind === "item" && next.row.kind === "item") {
    return previous.row.item === next.row.item;
  }
  if (previous.row.kind === "context" && next.row.kind === "context") {
    const nextItems = next.row.items;
    return (
      previous.row.items.length === nextItems.length &&
      previous.row.items.every((item, index) => item === nextItems[index])
    );
  }
  return false;
}

const DisplayRowView = memo(function DisplayRowView({ row }: { row: DisplayRow }) {
  if (row.kind === "item") return <Row item={row.item} />;
  if (row.kind === "context") return <ContextToolGroup items={row.items} />;
  if (row.kind === "status") return <TextShimmer className="text-sm">{row.text}</TextShimmer>;
  return (
    <div className="flex items-center gap-2 border-b border-border/60 pb-3">
      <button
        type="button"
        onClick={() => useApp.getState().exitSubagent()}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back
      </button>
      <span className="text-sm font-medium text-foreground">{row.agent}</span>
      <span className="truncate text-sm text-muted-foreground">{row.description}</span>
      <span className="ml-auto text-xs text-muted-foreground">
        {row.status === "running" ? "running…" : row.status === "error" ? "failed" : "completed"}
      </span>
    </div>
  );
}, sameDisplayRow);

function VirtualTranscript({ routeKey, rows }: { routeKey: string; rows: DisplayRow[] }) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const followingRef = useRef(routeFollowing.get(routeKey) ?? true);
  const [snapshot] = useState(() => routeSnapshots.get(routeKey));

  useEffect(() => {
    if (!followingRef.current) return;
    const frame = requestAnimationFrame(() => virtuosoRef.current?.autoscrollToBottom());
    return () => cancelAnimationFrame(frame);
  }, [rows]);

  useEffect(
    () => () => {
      routeFollowing.set(routeKey, followingRef.current);
      virtuosoRef.current?.getState((state) => routeSnapshots.set(routeKey, state));
    },
    [routeKey],
  );

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    followingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) followingRef.current = false;
  };

  return (
    <Virtuoso
      ref={virtuosoRef}
      className="min-h-0 flex-1"
      data={rows}
      alignToBottom
      computeItemKey={(_index, row) => row.key}
      defaultItemHeight={80}
      increaseViewportBy={{ top: 500, bottom: 700 }}
      initialTopMostItemIndex={
        snapshot ? undefined : { index: Math.max(0, rows.length - 1), align: "end" }
      }
      restoreStateFrom={snapshot}
      followOutput={() => (followingRef.current ? "auto" : false)}
      onScroll={handleScroll}
      onWheel={handleWheel}
      itemContent={(index, row) => (
        <div
          className={`mx-auto w-full max-w-190 px-6 pb-4 ${index === 0 ? "pt-6" : ""}`}
        >
          <DisplayRowView row={row} />
        </div>
      )}
    />
  );
}

export function Transcript() {
  const items = useApp((s) => s.items);
  const busy = useApp((s) => s.busy);
  const activeId = useApp((s) => s.activeId);
  const subagentView = useApp((s) => s.subagentView);
  const [verb, setVerb] = useState(() => pickSpinnerVerb());

  useEffect(() => {
    if (!busy) return;
    setVerb(pickSpinnerVerb());
    const interval = setInterval(() => setVerb(pickSpinnerVerb()), 4500);
    return () => clearInterval(interval);
  }, [busy]);

  const subagent = subagentView ? findSubagent(items, subagentView) : null;
  const rows = useMemo<DisplayRow[]>(() => {
    if (subagentView && subagent) {
      return [
        {
          key: `subagent-header:${subagent.sessionId}`,
          kind: "subagent-header",
          agent: subagent.agent,
          description: subagent.description,
          status: subagent.status,
        },
        ...transcriptRows(subagent.items),
        ...(subagent.status === "running"
          ? [{ key: `subagent-status:${subagent.sessionId}`, kind: "status" as const, text: "Working…" }]
          : []),
      ];
    }

    const next: DisplayRow[] = transcriptRows(items);
    if (busy && !items.some((item) => item.kind === "assistant" && item.streaming)) {
      next.push({ key: "session-status", kind: "status", text: `${verb}…` });
    }
    return next;
  }, [busy, items, subagent, subagentView, verb]);

  const routeKey = `${activeId ?? "none"}:${subagentView ?? "parent"}`;
  return <VirtualTranscript key={routeKey} routeKey={routeKey} rows={rows} />;
}
