import { useEffect, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { AgentMode } from "@cozycode/protocol";
import type { TuiSessionStatus } from "../../runtime/session-host.ts";
import type { TuiSessionUsage, TuiUnreadState } from "../../store/index.ts";
import { shortPath, theme } from "../../theme.ts";
import { SHELL_SIDEBAR_WIDTH } from "./AppShell.tsx";
import { sessionStatusPresentation } from "./status.ts";

export interface ShellSessionItem {
  id: string;
  title: string;
  workspace: string | null;
  modelLabel: string;
  mode: AgentMode;
  status: TuiSessionStatus;
  unread?: TuiUnreadState;
  updatedAt: number;
  turnCount: number;
}

export interface SessionSidebarProps {
  title: string;
  workspace: string | null;
  modelLabel: string;
  mode: AgentMode;
  effort?: string;
  usage?: TuiSessionUsage;
  contextWindow?: number;
  sessions: readonly ShellSessionItem[];
  currentSessionID: string | null;
  keyboardEnabled?: boolean;
  onSelectSession: (sessionID: string) => void;
  sessionListShortcut?: string;
}

export function SessionSidebar({
  title,
  workspace,
  modelLabel,
  mode,
  effort,
  usage,
  contextWindow,
  sessions,
  currentSessionID,
  keyboardEnabled = false,
  onSelectSession,
  sessionListShortcut = "ctrl+x l",
}: SessionSidebarProps) {
  const [cursorID, setCursorID] = useState<string>();
  const cursorRef = useRef<string | undefined>(undefined);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const ordered = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  const selectedID = ordered.some((session) => session.id === cursorID)
    ? cursorID
    : ordered.some((session) => session.id === currentSessionID)
      ? currentSessionID ?? undefined
      : ordered[0]?.id;
  const selectedIndex = Math.max(0, ordered.findIndex((session) => session.id === selectedID));
  cursorRef.current = selectedID;

  useEffect(() => {
    const box = scroll.current;
    if (!box || ordered.length === 0) return;
    const row = 12 + selectedIndex;
    if (row < box.scrollTop) box.scrollTo(row);
    if (row >= box.scrollTop + box.height) box.scrollTo(row - box.height + 1);
  }, [selectedIndex, ordered.length]);

  function move(delta: number) {
    if (ordered.length === 0) return;
    const next = (selectedIndex + delta + ordered.length) % ordered.length;
    cursorRef.current = ordered[next]?.id;
    setCursorID(ordered[next]?.id);
  }

  function select(sessionID: string | undefined) {
    if (!sessionID) return;
    cursorRef.current = sessionID;
    setCursorID(sessionID);
    onSelectSession(sessionID);
  }

  useKeyboard((key) => {
    if (!keyboardEnabled) return;
    if (key.name === "up") {
      key.stopPropagation();
      move(-1);
    } else if (key.name === "down") {
      key.stopPropagation();
      move(1);
    } else if (key.name === "return") {
      key.stopPropagation();
      select(cursorRef.current);
    }
  });

  const latestInput = usage?.turn?.inputTokens ?? 0;
  const latestOutput = usage?.turn?.outputTokens ?? 0;
  const contextPercent = contextWindow && latestInput > 0
    ? Math.min(100, Math.round((latestInput / contextWindow) * 100))
    : undefined;

  return (
    <box
      flexDirection="column"
      width={SHELL_SIDEBAR_WIDTH}
      height="100%"
      flexShrink={0}
      backgroundColor={theme.panel}
      paddingX={2}
      paddingY={1}
    >
      <scrollbox
        ref={(value: ScrollBoxRenderable | null) => {
          scroll.current = value;
        }}
        flexGrow={1}
        minHeight={1}
        scrollbarOptions={{ visible: false }}
      >
        <box flexDirection="column" paddingRight={1}>
          <text fg={theme.text} wrapMode="none"><b>{title}</b></text>
          <text fg={theme.muted} wrapMode="none">{workspace ? shortPath(workspace) : "No workspace"}</text>

          <SidebarSection title="Session">
            <text fg={theme.text} wrapMode="none">{modelLabel}</text>
            <text fg={mode === "plan" ? theme.accent : effort ? theme.warning : theme.success}>
              {`${mode === "plan" ? "PLAN / read-only" : "BUILD"}${effort ? ` / ${effort}` : ""}`}
            </text>
          </SidebarSection>

          <SidebarSection title="Context">
            {usage?.turn ? (
              <text fg={theme.text}>
                {`${formatTokens(latestInput)} → ${formatTokens(latestOutput)}${contextPercent === undefined ? "" : ` · ${contextPercent}%`}`}
              </text>
            ) : <text fg={theme.muted}>No completed turns</text>}
            <text fg={theme.muted}>{`${formatTokens(usage?.total.totalTokens ?? 0)} total tokens`}</text>
          </SidebarSection>

          <text fg={theme.primary} marginTop={1}>Sessions</text>
          {ordered.length === 0 ? <text fg={theme.muted}>No saved sessions</text> : ordered.map((session) => {
            const active = session.id === selectedID;
            const current = session.id === currentSessionID;
            const state = sessionStatusPresentation(session.status, session.unread ?? null);
            return (
              <box
                key={session.id}
                id={`shell-sidebar-session-${session.id}`}
                flexDirection="row"
                justifyContent="space-between"
                gap={1}
                backgroundColor={active ? theme.element : undefined}
                onMouseDown={() => setCursorID(session.id)}
                onMouseUp={() => select(session.id)}
              >
                <text fg={active ? theme.text : current ? theme.primary : theme.muted} wrapMode="none">
                  {active ? "> " : current ? "* " : "  "}{session.title}
                </text>
                <text fg={state.color} flexShrink={0}>{`${state.glyph} ${state.label}`}</text>
              </box>
            );
          })}
        </box>
      </scrollbox>
      <text fg={theme.muted}>{`${sessionListShortcut} all sessions`}</text>
    </box>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={theme.primary}>{title}</text>
      {children}
    </box>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}
