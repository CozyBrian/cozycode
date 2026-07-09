import { useState } from "react";
import { MessageSquare, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { SessionMeta } from "../../../shared/ipc.ts";
import { useApp } from "../store/app-store";
import { relativeTime } from "../lib/relative-time";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function SidebarSessionRow({ session, now }: { session: SessionMeta; now: number }) {
  const activeId = useApp((s) => s.activeId);
  const activate = useApp((s) => s.activateSession);
  const rename = useApp((s) => s.renameSession);
  const remove = useApp((s) => s.deleteSession);
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
    <div
      className={cn(
        "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-sidebar-foreground/80 transition-colors",
        active ? "bg-sidebar-accent text-sidebar-foreground" : "hover:bg-white/5",
      )}
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
          <span className="shrink-0 text-xs text-muted-foreground group-hover:hidden">
            {relativeTime(session.updatedAt, now)}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={(e) => e.stopPropagation()}
                className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-white/10 hover:text-foreground group-hover:flex"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem
                onSelect={() => {
                  setDraft(session.title);
                  setEditing(true);
                }}
              >
                <Pencil className="size-4" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => void remove(session.id)}>
                <Trash2 className="size-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
    </div>
  );
}
