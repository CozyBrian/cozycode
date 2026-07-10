import { useState, type ReactNode } from "react";
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
  run_shell: "$",
  read_file: "→",
  write_file: "←",
  edit_file: "←",
  search: "✱",
  grep: "✱",
};

export function ToolRow({ item }: { item: Extract<RenderItem, { kind: "tool" }> }) {
  if (item.toolName === "run_shell") return <Shell item={item} />;
  if ((item.toolName === "write_file" || item.toolName === "edit_file") && diffPayload(item)) {
    return <FileChange item={item} />;
  }
  return <InlineTool item={item} />;
}

function InlineTool({ item }: { item: Extract<RenderItem, { kind: "tool" }> }) {
  const failed = item.status === "error";
  const denied = item.status === "denied";
  const [showError, setShowError] = useState(false);
  const label = toolLabel(item);
  const color = STATUS_COLOR[item.status];

  return (
    <box flexDirection="column" paddingLeft={3} onMouseUp={() => failed && setShowError((value) => !value)}>
      <box flexDirection="row">
        <text width={2} fg={color}>
          {item.status === "running" ? "~" : failed ? "✗" : GLYPHS[item.toolName] ?? "⚙"}
        </text>
        <text fg={color} attributes={denied ? 8 : undefined}>
          {item.status === "running" ? pendingLabel(item) : label}
        </text>
      </box>
      {failed && showError ? <text paddingLeft={2} fg={theme.error}>{preview(item.result)}</text> : null}
    </box>
  );
}

function Shell({ item }: { item: Extract<RenderItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  const result = record(item.result);
  const output = shellOutput(result);
  const lines = output.split("\n");
  const overflow = lines.length > 10;
  const displayed = expanded || !overflow ? output : lines.slice(0, 10).join("\n");
  const command = stringArg(item.args, "command") ?? "";

  if (item.status === "running" || !result) return <InlineTool item={item} />;
  if (item.status === "denied" || item.status === "error") return <InlineTool item={item} />;

  return (
    <BlockTool
      title={stringArg(item.args, "cwd") ? `# Running in ${stringArg(item.args, "cwd")}` : undefined}
      onMouseUp={overflow ? () => setExpanded((value) => !value) : undefined}
    >
      <text fg={theme.text}>$ {command}</text>
      {displayed ? <text fg={theme.text}>{displayed}</text> : null}
      {result.timedOut === true ? <text fg={theme.warning}>Command timed out</text> : null}
      {result.truncated === true ? <text fg={theme.warning}>Output truncated</text> : null}
      {overflow ? <text fg={theme.muted}>{expanded ? "Click to collapse" : "Click to expand"}</text> : null}
    </BlockTool>
  );
}

function FileChange({ item }: { item: Extract<RenderItem, { kind: "tool" }> }) {
  const diff = diffPayload(item);
  if (!diff) return <InlineTool item={item} />;
  const path = stringArg(item.args, "path") ?? "file";
  const action = item.toolName === "write_file" ? "Wrote" : "Edit";
  return (
    <BlockTool title={`← ${action} ${path}`}>
      <Diff patch={diff} />
    </BlockTool>
  );
}

function BlockTool({ title, children, onMouseUp }: { title?: string; children: ReactNode; onMouseUp?: () => void }) {
  return (
    <box
      flexDirection="column"
      marginTop={1}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      border={["left"]}
      borderColor={theme.bg}
      backgroundColor={theme.panel}
      onMouseUp={onMouseUp}
    >
      {title ? <text paddingLeft={3} fg={theme.muted}>{title}</text> : null}
      <box flexDirection="column" gap={1}>
        {children}
      </box>
    </box>
  );
}

function toolLabel(item: Extract<RenderItem, { kind: "tool" }>): string {
  const path = stringArg(item.args, "path");
  if (item.toolName === "read_file") return `Read ${path ?? "file"}`;
  if (item.toolName === "write_file") return `Write ${path ?? "file"}`;
  if (item.toolName === "edit_file") return `Edit ${path ?? "file"}`;
  if (item.toolName === "search") {
    const result = record(item.result);
    const matches = Array.isArray(result?.matches) ? result.matches.length : undefined;
    const suffix = matches === undefined ? "" : ` (${matches} ${matches === 1 ? "match" : "matches"})`;
    const scope = path ? ` in ${path}` : "";
    const pattern = stringArg(item.args, "pattern");
    return pattern
      ? `Grep "${pattern}"${scope}${suffix}`
      : `Glob "${stringArg(item.args, "glob") ?? "*"}"${scope}${suffix}`;
  }
  if (item.toolName === "run_shell") return `$ ${stringArg(item.args, "command") ?? ""}`;
  return `${item.toolName} ${summary(item.args)}`.trim();
}

function pendingLabel(item: Extract<RenderItem, { kind: "tool" }>): string {
  if (item.toolName === "read_file") return "Reading file...";
  if (item.toolName === "search") return "Searching...";
  if (item.toolName === "write_file") return "Preparing write...";
  if (item.toolName === "edit_file") return "Preparing edit...";
  if (item.toolName === "run_shell") return "Running command...";
  return `Running ${item.toolName}...`;
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

function diffPayload(item: Extract<RenderItem, { kind: "tool" }>): string | undefined {
  return typeof item.metadata?.diff === "string" ? item.metadata.diff : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArg(value: unknown, key: string): string | undefined {
  const args = record(value);
  return typeof args?.[key] === "string" ? args[key] : undefined;
}

function shellOutput(result: Record<string, unknown> | undefined): string {
  if (!result) return "";
  return [result.stdout, result.stderr]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .trim();
}
