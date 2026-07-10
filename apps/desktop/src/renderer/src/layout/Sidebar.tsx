import { useCallback, useMemo, useRef, useState } from "react";
import { FolderClosed, Search as SearchIcon, SquarePen } from "lucide-react";
import { useApp } from "../store/app-store";
import type { SessionMeta } from "../../../shared/ipc.ts";
import { SidebarSessionRow } from "./SidebarSessionRow";
import { SidebarFooter } from "./SidebarFooter";
import { TitleBar } from "./TitleBar";
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
  const width = useApp((s) => s.sidebarWidth);
  const setWidth = useApp((s) => s.setSidebarWidth);
  const sessions = useApp((s) => s.sessions);
  const createSession = useApp((s) => s.createSession);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const now = Date.now();

  const asideRef = useRef<HTMLElement>(null);

  const filtered = useMemo(() => {
    // Subagent (child) sessions are reached via their parent's task card, not the
    // top-level list.
    const top = sessions.filter((s) => !s.parentID);
    const q = query.trim().toLowerCase();
    return q ? top.filter((s) => s.title.toLowerCase().includes(q)) : top;
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

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const el = asideRef.current;
      if (el) el.style.transition = "none";
      const startX = e.clientX;
      const startW = width;
      const onMove = (ev: PointerEvent) => setWidth(startW + (ev.clientX - startX));
      const onUp = () => {
        if (el) el.style.transition = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, setWidth],
  );

  return (
    <aside
      ref={asideRef}
      className="relative h-full shrink-0 overflow-hidden bg-sidebar backdrop-blur-2xl transition-[max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
      style={{ maxWidth: open ? `${width}px` : "0px" }}
    >
      <div className="flex h-full flex-col" style={{ width }}>
        <TitleBar />

        {/* Top actions */}
        <nav className="app-drag flex flex-col gap-0.5 px-3 pt-1 pb-1">
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
      {/* Resize handle */}
      {open ? (
        <div
          onPointerDown={onResizeStart}
          className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize"
        />
      ) : null}
      {/* Border sits inside the clippable area so it disappears when collapsed */}
      <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-sidebar-border" />
    </aside>
  );
}
