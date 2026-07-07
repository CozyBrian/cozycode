import type { TranscriptItem } from "../transcript.ts";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

const STATUS_LABEL: Record<ToolItem["status"], string> = {
  running: "running…",
  done: "done",
  error: "error",
  denied: "denied",
};

export function ToolCard({ item }: { item: ToolItem }) {
  return (
    <div className={`tool-card ${item.status}`}>
      <div className="tool-card-head">
        <span className="tool-card-name">{item.toolName}</span>
        <span className={`tool-card-status ${item.status}`}>{STATUS_LABEL[item.status]}</span>
      </div>
      <pre className="tool-card-args">{compact(item.args)}</pre>
      {item.result !== undefined && (
        <pre className="tool-card-result">{compact(item.result)}</pre>
      )}
    </div>
  );
}

function compact(value: unknown): string {
  const s = JSON.stringify(value, null, 2) ?? String(value);
  return s.length > 1200 ? s.slice(0, 1200) + "\n…" : s;
}
