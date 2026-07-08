import type { AgentMode, TokenUsage } from "@cozycode/protocol";
import type { RenderItem } from "../transcript.ts";
import { shortPath, theme } from "../theme.ts";

interface Props {
  model: string;
  mode: AgentMode;
  workspaceRoot: string;
  usage?: TokenUsage;
  items: RenderItem[];
  /** Rendered as an absolute overlay on narrow terminals. */
  overlay?: boolean;
}

const SIDEBAR_WIDTH = 42;
const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

/**
 * Right-hand context panel (mirrors opencode's sidebar). Shows the current
 * model, workspace, token usage, and per-session tool/file activity — all
 * derived from the transcript, so it needs no extra state.
 */
export function Sidebar({ model, mode, workspaceRoot, usage, items, overlay }: Props) {
  const tools = toolCounts(items);
  const files = filesTouched(items);

  return (
    <box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      height="100%"
      flexShrink={0}
      backgroundColor={theme.panel}
      border={overlay ? true : ["left"]}
      borderStyle={overlay ? "rounded" : "single"}
      borderColor={theme.border}
      paddingX={2}
      paddingY={1}
      position={overlay ? "absolute" : undefined}
      right={overlay ? 0 : undefined}
      top={overlay ? 0 : undefined}
      zIndex={overlay ? 50 : undefined}
    >
      <Section title="Mode">
        {mode === "plan" ? (
          <text fg={theme.accent}>PLAN (read-only)</text>
        ) : (
          <text fg={theme.success}>BUILD</text>
        )}
      </Section>
      <Section title="Model">
        <text fg={theme.text}>{model}</text>
      </Section>
      <Section title="Workspace">
        <text fg={theme.text}>{shortPath(workspaceRoot)}</text>
      </Section>
      <Section title="Usage">
        <text fg={theme.text}>
          {(usage?.inputTokens ?? 0)}
          <span style={{ fg: theme.muted }}>{" → "}</span>
          {(usage?.outputTokens ?? 0)}
          <span style={{ fg: theme.muted }}>{" tokens"}</span>
        </text>
      </Section>
      <Section title="Tools">
        {tools.length === 0 ? (
          <text fg={theme.muted}>none yet</text>
        ) : (
          tools.map(([name, count]) => (
            <box key={name} flexDirection="row" justifyContent="space-between">
              <text fg={theme.text}>{name}</text>
              <text fg={theme.muted}>{count}</text>
            </box>
          ))
        )}
      </Section>
      <Section title="Files">
        {files.length === 0 ? (
          <text fg={theme.muted}>none yet</text>
        ) : (
          files.slice(0, 12).map((path) => (
            <text key={path} fg={theme.text}>
              {shortPath(path)}
            </text>
          ))
        )}
        {files.length > 12 ? <text fg={theme.muted}>{`+${files.length - 12} more`}</text> : null}
      </Section>
    </box>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={theme.primary}>{title}</text>
      {children}
    </box>
  );
}

function toolCounts(items: RenderItem[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "tool") counts.set(item.toolName, (counts.get(item.toolName) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function filesTouched(items: RenderItem[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool" || !FILE_TOOLS.has(item.toolName)) continue;
    const args = item.args as { path?: unknown } | null;
    if (args && typeof args.path === "string") seen.add(args.path);
  }
  return [...seen];
}
