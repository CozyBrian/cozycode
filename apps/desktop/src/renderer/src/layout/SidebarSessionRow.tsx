import { useState } from "react";
import { Download, MessageSquare, Pencil, Trash2 } from "lucide-react";
import type { SessionMeta } from "../../../shared/ipc.ts";
import { isSessionRunningInBackground, useApp } from "../store/app-store";
import { relativeTime } from "../lib/relative-time";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

export function SidebarSessionRow({ session, now }: { session: SessionMeta; now: number }) {
  const activeId = useApp((s) => s.activeId);
  const activate = useApp((s) => s.activateSession);
  const rename = useApp((s) => s.renameSession);
  const remove = useApp((s) => s.deleteSession);
  const exportSession = useApp((s) => s.exportSession);
  const runningInBackground = useApp((s) => isSessionRunningInBackground(s, session.id));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  const active = session.id === activeId;

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== session.title) void rename(session.id, next);
    else setDraft(session.title);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group relative flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-sidebar-foreground/80 transition-colors",
            active ? "bg-sidebar-accent text-sidebar-foreground" : "hover:bg-white/5",
            runningInBackground && "background-session-glow",
          )}
          aria-label={runningInBackground ? `${session.title}, running in background` : session.title}
          onClick={() => !editing && void activate(session.id)}
        >
          <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setDraft(session.title);
                  setEditing(false);
                }
              }}
              className="app-no-drag min-w-0 flex-1 rounded bg-white/10 px-1 py-0.5 text-sm outline-none ring-1 ring-ring"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              {runningInBackground && <span className="sr-only">Running in background</span>}
              <span className="shrink-0 text-xs text-muted-foreground">
                {relativeTime(session.updatedAt, now)}
              </span>
            </>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onSelect={() => {
            setDraft(session.title);
            setEditing(true);
          }}
        >
          <Pencil className="size-4" /> Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void exportSession(session.id)}>
          <Download className="size-4" /> Export Markdown
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => void remove(session.id)}>
          <Trash2 className="size-4" /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
