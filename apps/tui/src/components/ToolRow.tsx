import type { RenderItem, ToolStatus } from "../transcript.ts";
import { theme } from "../theme.ts";
import { Diff } from "./Diff.tsx";

const STATUS_COLOR: Record<ToolStatus, string> = {
  running: theme.text,
  done: theme.muted,
  error: theme.error,
  denied: theme.error,
};

const GLYPHS: Record<string, string> = {
  shell: "$",
  read_file: "→",
  write_file: "←",
  edit_file: "←",
  search: "✱",
  grep: "✱",
};

export function ToolRow({ item }: { item: Extract<RenderItem, { kind: "tool" }> }) {
  const glyph = GLYPHS[item.toolName] ?? "⚙";
  const diff = diffPayload(item);
  const failed = item.status === "error";
  const denied = item.status === "denied";

  return (
    <box flexDirection="column" marginTop={1} paddingLeft={3}>
      <box flexDirection="row">
        <box width={2}>
          <text fg={STATUS_COLOR[item.status]}>{item.status === "running" ? "~" : failed ? "✗" : glyph}</text>
        </box>
        <text fg={STATUS_COLOR[item.status]}>
          {item.status === "running" ? "~ " : ""}
          <span style={{ attributes: denied ? 8 : 0 }}>{item.toolName}</span>
        </text>
        <text fg={theme.muted}> {summary(item.args)}</text>
      </box>
      {diff ? (
        <box marginLeft={2} marginTop={1} height={Math.min(12, Math.max(4, diff.newText.split("\n").length + diff.oldText.split("\n").length + 4))}>
          <Diff oldText={diff.oldText} newText={diff.newText} />
        </box>
      ) : item.result !== undefined && item.status !== "running" ? (
        <box marginLeft={2} marginTop={1}>
          <text fg={theme.muted}>{preview(item.result)}</text>
        </box>
      ) : null}
    </box>
  );
}

function summary(value: unknown): string {
  if (value && typeof value === "object") {
    const args = value as Record<string, unknown>;
    const path = typeof args.path === "string" ? args.path : undefined;
    if (path) return path;
  }
  return oneLine(value, 90);
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  const clipped = text.split("\n").slice(0, 8).join("\n");
  return clipped.length > 600 ? `${clipped.slice(0, 600)}\n…` : clipped;
}

function oneLine(value: unknown, max: number): string {
  const s = JSON.stringify(value) ?? "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function diffPayload(item: Extract<RenderItem, { kind: "tool" }>): { oldText: string; newText: string } | null {
  if (item.status === "running" || item.status === "denied") return null;
  const args = item.args && typeof item.args === "object" ? (item.args as Record<string, unknown>) : null;
  if (!args) return null;
  if (item.toolName === "write_file" && typeof args.content === "string") {
    return { oldText: "", newText: args.content };
  }
  if (item.toolName === "edit_file") {
    const oldText = typeof args.oldText === "string" ? args.oldText : typeof args.old === "string" ? args.old : "";
    const newText = typeof args.newText === "string" ? args.newText : typeof args.new === "string" ? args.new : "";
    if (oldText || newText) return { oldText, newText };
  }
  return null;
}
