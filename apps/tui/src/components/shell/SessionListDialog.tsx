import { useEffect, useRef, useState } from "react";
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { RGBA } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { shortPath, theme } from "../../theme.ts";
import type { ShellSessionItem } from "./SessionSidebar.tsx";
import { sessionStatusPresentation } from "./status.ts";

export interface SessionListDialogProps {
  sessions: readonly ShellSessionItem[];
  currentSessionID: string | null;
  onSelect: (sessionID: string) => void;
  onCancel: () => void;
  onRename: (sessionID: string) => void;
  onDelete: (sessionID: string) => void;
  onFork: (sessionID: string) => void;
  initialQuery?: string;
}

export function SessionListDialog({
  sessions,
  currentSessionID,
  onSelect,
  onCancel,
  onRename,
  onDelete,
  onFork,
  initialQuery = "",
}: SessionListDialogProps) {
  const dimensions = useTerminalDimensions();
  const [query, setQuery] = useState(initialQuery);
  const [cursorID, setCursorID] = useState<string>();
  const cursorRef = useRef<string | undefined>(undefined);
  const scroll = useRef<ScrollBoxRenderable | null>(null);
  const filtered = [...sessions]
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .filter((session) => matchesSession(session, query));
  const selectedID = filtered.some((session) => session.id === cursorID)
    ? cursorID
    : filtered.some((session) => session.id === currentSessionID)
      ? currentSessionID ?? undefined
      : filtered[0]?.id;
  const selectedIndex = Math.max(0, filtered.findIndex((session) => session.id === selectedID));
  cursorRef.current = selectedID;
  const dialogWidth = Math.max(1, Math.min(78, dimensions.width - 4));
  const listHeight = Math.max(2, Math.min(filtered.length * 2 || 2, Math.max(4, dimensions.height - 10)));

  useEffect(() => {
    const box = scroll.current;
    if (!box || filtered.length === 0) return;
    const row = selectedIndex * 2;
    if (row < box.scrollTop) box.scrollTo(row);
    if (row + 1 >= box.scrollTop + box.height) box.scrollTo(row - box.height + 2);
  }, [selectedIndex, filtered.length]);

  function move(delta: number) {
    if (filtered.length === 0) return;
    const next = (selectedIndex + delta + filtered.length) % filtered.length;
    cursorRef.current = filtered[next]?.id;
    setCursorID(filtered[next]?.id);
  }

  function withSelected(callback: (sessionID: string) => void) {
    if (cursorRef.current) callback(cursorRef.current);
  }

  useKeyboard((key) => {
    if (key.name === "escape") {
      key.stopPropagation();
      onCancel();
      return;
    }
    if (key.ctrl && key.name === "r") {
      key.stopPropagation();
      withSelected(onRename);
      return;
    }
    if (key.ctrl && key.name === "d") {
      key.stopPropagation();
      withSelected(onDelete);
      return;
    }
    if (key.ctrl && key.name === "f") {
      key.stopPropagation();
      withSelected(onFork);
      return;
    }
    if (key.name === "up") {
      key.stopPropagation();
      move(-1);
    } else if (key.name === "down") {
      key.stopPropagation();
      move(1);
    } else if (key.name === "pageup") {
      key.stopPropagation();
      move(-Math.max(1, Math.floor(listHeight / 2)));
    } else if (key.name === "pagedown") {
      key.stopPropagation();
      move(Math.max(1, Math.floor(listHeight / 2)));
    } else if (key.name === "return") {
      key.stopPropagation();
      withSelected(onSelect);
    }
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={200}
      alignItems="center"
      justifyContent="center"
      backgroundColor={RGBA.fromInts(0, 0, 0, 82)}
    >
      <box
        flexDirection="column"
        width={dialogWidth}
        backgroundColor={theme.panel}
        borderStyle="rounded"
        borderColor={theme.borderActive}
        paddingX={2}
        paddingY={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text}><b>Sessions</b></text>
          <text fg={theme.muted}>esc close</text>
        </box>
        <box marginTop={1} paddingLeft={2}>
          <input
            ref={(value: InputRenderable | null) => {
              if (value && value.value === initialQuery) value.cursorOffset = initialQuery.length;
            }}
            focused
            placeholder="Search title, model, or workspace"
            value={query}
            onInput={(value: string) => {
              setQuery(value);
              cursorRef.current = undefined;
              setCursorID(undefined);
            }}
          />
        </box>
        <box height={listHeight} marginTop={1}>
          <scrollbox
            ref={(value: ScrollBoxRenderable | null) => {
              scroll.current = value;
            }}
            flexGrow={1}
            scrollbarOptions={{ visible: false }}
          >
            {filtered.length === 0 ? (
              <text fg={theme.muted}>No matching sessions</text>
            ) : filtered.map((session) => {
              const active = session.id === selectedID;
              const current = session.id === currentSessionID;
              const state = sessionStatusPresentation(session.status, session.unread ?? null);
              const foreground = active ? theme.bg : theme.text;
              return (
                <box
                  key={session.id}
                  id={`shell-dialog-session-${session.id}`}
                  flexDirection="column"
                  backgroundColor={active ? theme.primary : undefined}
                  onMouseDown={() => setCursorID(session.id)}
                  onMouseUp={() => onSelect(session.id)}
                >
                  <box flexDirection="row" justifyContent="space-between" gap={2}>
                    <text fg={foreground} wrapMode="none">
                      {current ? "* " : "  "}{session.title}
                    </text>
                    <text fg={active ? theme.bg : state.color} flexShrink={0}>{`${state.glyph} ${state.label}`}</text>
                  </box>
                  <text fg={active ? theme.bg : theme.muted} wrapMode="none">
                    {`${session.modelLabel}  /  ${session.workspace ? shortPath(session.workspace) : "No workspace"}  /  ${session.mode.toUpperCase()}`}
                  </text>
                </box>
              );
            })}
          </scrollbox>
        </box>
        <box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <box flexDirection="row" gap={2}>
            <DialogAction label="rename" shortcut="ctrl+r" onTrigger={() => withSelected(onRename)} />
            <DialogAction label="fork" shortcut="ctrl+f" onTrigger={() => withSelected(onFork)} />
            <DialogAction label="delete" shortcut="ctrl+d" onTrigger={() => withSelected(onDelete)} />
          </box>
          <text fg={theme.muted}>{`${filtered.length} sessions`}</text>
        </box>
      </box>
    </box>
  );
}

function DialogAction({ label, shortcut, onTrigger }: { label: string; shortcut: string; onTrigger: () => void }) {
  return (
    <box
      flexDirection="row"
      onMouseUp={(event) => {
        event.stopPropagation();
        onTrigger();
      }}
    >
      <text fg={theme.text}>{label}</text>
      <text fg={theme.muted}>{` ${shortcut}`}</text>
    </box>
  );
}

function matchesSession(session: ShellSessionItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    session.title,
    session.modelLabel,
    session.workspace ?? "",
    session.mode,
    session.status,
  ].join(" ").toLowerCase();
  return needle.split(/\s+/).every((part) => haystack.includes(part));
}
