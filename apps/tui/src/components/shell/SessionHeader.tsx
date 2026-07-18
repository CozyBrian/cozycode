import type { TuiSessionStatus } from "../../runtime/session-host.ts";
import { shortPath, theme } from "../../theme.ts";
import { sessionStatusPresentation } from "./status.ts";

export interface SessionParentCue {
  title: string;
  shortcut?: string;
}

export interface SessionChildCue {
  label?: string;
  index: number;
  total: number;
  parentTitle?: string;
}

export interface SessionHeaderProps {
  title: string;
  workspace: string | null;
  status: TuiSessionStatus;
  parent?: SessionParentCue;
  child?: SessionChildCue;
  childCount?: number;
}

export function SessionHeader({
  title,
  workspace,
  status,
  parent,
  child,
  childCount = 0,
}: SessionHeaderProps) {
  const state = sessionStatusPresentation(status);
  return (
    <box flexDirection="column" flexShrink={0} paddingX={2} paddingTop={1}>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.text} wrapMode="none">
          <b>{title}</b>
        </text>
        <text fg={state.color} flexShrink={0}>{`${state.glyph} ${state.label}`}</text>
      </box>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme.muted} wrapMode="none">{workspace ? shortPath(workspace) : "No workspace"}</text>
        {child ? (
          <text fg={theme.accent} flexShrink={0}>
            {`${child.label ?? "child"} ${child.index}/${child.total}`}
          </text>
        ) : parent ? (
          <text fg={theme.accent} flexShrink={0}>
            {`parent: ${parent.title}${parent.shortcut ? `  ${parent.shortcut}` : ""}`}
          </text>
        ) : childCount > 0 ? (
          <text fg={theme.accent} flexShrink={0}>
            {`${childCount} ${childCount === 1 ? "child" : "children"}`}
          </text>
        ) : null}
      </box>
      {child?.parentTitle ? <text fg={theme.muted}>{`parent: ${child.parentTitle}`}</text> : null}
    </box>
  );
}
