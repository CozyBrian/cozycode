import { useMemo, useState } from "react";
import {
  CalendarClock,
  FolderClosed,
  Plug,
  Search as SearchIcon,
  SquarePen,
} from "lucide-react";
import { useApp } from "../store/app-store";
import type { SessionMeta } from "../../../shared/ipc.ts";
import { SidebarSessionRow } from "./SidebarSessionRow";
import { SidebarFooter } from "./SidebarFooter";
import { cn } from "@/lib/utils";

function ActionRow({
  icon,
  label,
  onClick,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "app-no-drag flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-sidebar-foreground/85 transition-colors hover:bg-white/6 hover:text-sidebar-foreground",
        active && "bg-white/6 text-sidebar-foreground",
      )}
    >
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      {label}
    </button>
  );
}

function projectName(root: string): string {
  const parts = root.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

export function Sidebar() {
  const open = useApp((s) => s.sidebarOpen);
  const sessions = useApp((s) => s.sessions);
  const createSession = useApp((s) => s.createSession);
  const openSettings = useApp((s) => s.openSettings);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const now = Date.now();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
  }, [sessions, query]);

  const { projects, chats } = useMemo(() => {
    const byProject = new Map<string, SessionMeta[]>();
    const standalone: SessionMeta[] = [];
    for (const s of filtered) {
      if (s.workspaceRoot) {
        const arr = byProject.get(s.workspaceRoot) ?? [];
        arr.push(s);
        byProject.set(s.workspaceRoot, arr);
      } else {
        standalone.push(s);
      }
    }
    return { projects: [...byProject.entries()], chats: standalone };
  }, [filtered]);

  return (
    <aside
      className={cn(
        "h-full shrink-0 overflow-hidden bg-sidebar backdrop-blur-2xl transition-[width] duration-200 ease-out",
        open ? "w-[290px] border-r border-sidebar-border" : "w-0 border-r-0",
      )}
    >
      <div className="flex h-full w-[290px] flex-col">
        {/* Top actions */}
        <nav className="app-drag flex flex-col gap-0.5 px-3 pt-3 pb-1">
          <ActionRow
            icon={<SquarePen />}
            label="New chat"
            onClick={() => void createSession()}
          />
          <ActionRow
            icon={<SearchIcon />}
            label="Search"
            active={searching}
            onClick={() => setSearching((v) => !v)}
          />
          <ActionRow icon={<CalendarClock />} label="Scheduled" onClick={openSettings} />
          <ActionRow icon={<Plug />} label="Plugins" onClick={openSettings} />
        </nav>

        {searching && (
          <div className="app-no-drag px-3 pb-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats…"
              className="w-full rounded-lg bg-white/6 px-2.5 py-1.5 text-sm outline-none ring-1 ring-transparent focus:ring-ring"
            />
          </div>
        )}

        {/* Scrollable session list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          {projects.map(([root, list]) => (
            <div key={root} className="mt-3">
              <div className="flex items-center gap-1.5 px-2 pb-1 text-xs font-medium text-muted-foreground">
                <FolderClosed className="size-3.5" />
                <span className="truncate">{projectName(root)}</span>
              </div>
              <div className="flex flex-col gap-0.5">
                {list.map((s) => (
                  <SidebarSessionRow key={s.id} session={s} now={now} />
                ))}
              </div>
            </div>
          ))}

          {chats.length > 0 && (
            <div className="mt-3">
              <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">Chats</div>
              <div className="flex flex-col gap-0.5">
                {chats.map((s) => (
                  <SidebarSessionRow key={s.id} session={s} now={now} />
                ))}
              </div>
            </div>
          )}

          {filtered.length === 0 && (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              {query ? "No matching chats" : "No chats yet"}
            </div>
          )}
        </div>

        <SidebarFooter />
      </div>
    </aside>
  );
}
