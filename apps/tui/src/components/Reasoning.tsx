import { useState } from "react";
import type { RenderItem } from "../transcript.ts";
import { theme } from "../theme.ts";
import { Markdown } from "./Markdown.tsx";

/**
 * A reasoning/thinking block. Collapsed by default to a single dimmed header
 * line; click (onMouseUp) toggles the dimmed markdown body — the same
 * expand idiom as ToolRow's shell/file panels. Mirrors opencode's collapsed,
 * muted reasoning rendering.
 */
export function Reasoning({ item }: { item: Extract<RenderItem, { kind: "reasoning" }> }) {
  const [expanded, setExpanded] = useState(false);
  const { title, body } = splitSummary(item.text);
  const header = item.streaming
    ? title ?? "Thinking…"
    : `Thought${title ? ` · ${title}` : ""}${duration(item.durationMs)}`;
  const hasBody = body.trim().length > 0;

  return (
    <box
      flexDirection="column"
      marginTop={1}
      paddingLeft={2}
      border={["left"]}
      borderColor={theme.border}
      onMouseUp={hasBody ? () => setExpanded((value) => !value) : undefined}
    >
      <box flexDirection="row">
        <text width={2} fg={theme.muted}>∴</text>
        <text fg={theme.muted}>
          {header}
          {hasBody ? (expanded ? "  (click to collapse)" : "  (click to expand)") : ""}
        </text>
      </box>
      {expanded && hasBody ? (
        <box paddingLeft={2} marginTop={1}>
          <Markdown text={body} />
        </box>
      ) : null}
    </box>
  );
}

/** Whole-seconds duration suffix, e.g. " for 12s"; empty when unknown. */
function duration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ` for ${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * Split a leading `**Title**` line (OpenAI Responses summary style) from the
 * body so the collapsed header can show the title. No title → the whole text
 * is the body.
 */
function splitSummary(text: string): { title?: string; body: string } {
  const match = text.match(/^\s*\*\*(.+?)\*\*\s*\n?/);
  if (!match) return { body: text };
  return { title: match[1]!.trim(), body: text.slice(match[0].length) };
}
