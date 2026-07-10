import type { TranscriptItem } from "../transcript.ts";

export type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

export const CONTEXT_TOOLS = new Set(["read_file", "search"]);

export function isContextTool(item: TranscriptItem): item is ToolItem {
  return item.kind === "tool" && CONTEXT_TOOLS.has(item.toolName) && item.status !== "error" && item.status !== "denied";
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringArg(value: unknown, key: string): string | undefined {
  const args = record(value);
  return typeof args?.[key] === "string" ? args[key] : undefined;
}

export function toolLabel(item: ToolItem): string {
  const path = stringArg(item.args, "path");
  if (item.toolName === "read_file") return `Read ${path ?? "file"}`;
  if (item.toolName === "write_file") return `Write ${path ?? "file"}`;
  if (item.toolName === "edit_file") return `Edit ${path ?? "file"}`;
  if (item.toolName === "search") {
    const matches = record(item.result)?.matches;
    const count = Array.isArray(matches) ? ` (${matches.length} ${matches.length === 1 ? "match" : "matches"})` : "";
    const pattern = stringArg(item.args, "pattern");
    const scope = path ? ` in ${path}` : "";
    return pattern
      ? `Grep \"${pattern}\"${scope}${count}`
      : `Glob \"${stringArg(item.args, "glob") ?? "*"}\"${scope}${count}`;
  }
  if (item.toolName === "run_shell") return `Shell ${stringArg(item.args, "command") ?? ""}`.trim();
  if (item.toolName === "webfetch") return `Fetch ${stringArg(item.args, "url") ?? ""}`.trim();
  if (item.toolName === "websearch") return `Search "${stringArg(item.args, "query") ?? ""}"`;
  if (item.toolName === "apply_patch") return "Apply patch";
  return item.toolName.replaceAll("_", " ");
}

export function pendingLabel(item: ToolItem): string {
  if (item.toolName === "read_file") return "Reading file";
  if (item.toolName === "search") return "Searching";
  if (item.toolName === "write_file") return "Writing file";
  if (item.toolName === "edit_file") return "Editing file";
  if (item.toolName === "run_shell") return "Running command";
  if (item.toolName === "webfetch") return "Fetching URL";
  if (item.toolName === "websearch") return "Searching the web";
  if (item.toolName === "apply_patch") return "Applying patch";
  return `Running ${item.toolName.replaceAll("_", " ")}`;
}

export function diffPayload(item: ToolItem): string | undefined {
  return typeof item.metadata?.diff === "string" ? item.metadata.diff : undefined;
}

export function changeCounts(patch: string): { additions: number; deletions: number } {
  return patch.split("\n").reduce(
    (counts, line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return counts;
      if (line.startsWith("+")) counts.additions += 1;
      if (line.startsWith("-")) counts.deletions += 1;
      return counts;
    },
    { additions: 0, deletions: 0 },
  );
}

export function shellOutput(value: unknown): string {
  const result = record(value);
  if (!result) return "";
  return [result.stdout, result.stderr]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n")
    .replace(/\r\n?/g, "\n")
    .trim();
}

export function resultPreview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
  const clipped = text.split("\n").slice(0, 12).join("\n");
  return clipped.length > 1200 ? `${clipped.slice(0, 1200)}\n...` : clipped;
}
