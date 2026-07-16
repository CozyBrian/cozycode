import { forwardRef, useCallback, useMemo, useRef, useState } from "react";
import { ArrowLeft, FolderClosed, FolderOpen, Search as SearchIcon, SquarePen, Trash2 } from "lucide-react";
import { AnimatePresence, motion, Reorder, useReducedMotion } from "motion/react";
import { newChatWorkspace, useApp, type SettingsSection } from "../store/app-store";
import type { SessionMeta } from "../../../shared/ipc.ts";
import { SidebarSessionRow } from "./SidebarSessionRow";
import { SidebarFooter } from "./SidebarFooter";
import { TitleBar } from "./TitleBar";
import { SETTINGS_SECTIONS } from "../components/settings/sections";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ActionRow = forwardRef<HTMLButtonElement, {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "onClick">>(function ActionRow({
  icon,
  label,
  onClick,
  active,
  ...props
}, ref) {
  return (
    <button
      {...props}
      ref={ref}
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
});

function projectName(root: string): string {
  const parts = root.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

function SettingsSidebarView({
  section,
  onSelect,
  onBack,
  canLeave,
}: {
  section: SettingsSection;
  onSelect: (section: (typeof SETTINGS_SECTIONS)[number]["id"]) => void;
  onBack: () => void;
  canLeave: boolean;
}) {
  return (
    <div className="flex h-full flex-col px-3 pt-2">
      <div className="px-2 pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Settings</div>
      <nav className="app-drag flex flex-col gap-0.5">
        {canLeave && <ActionRow icon={<ArrowLeft />} label="Chats" onClick={onBack} />}
        {canLeave && <div className="my-1 border-t border-sidebar-border" />}
        {SETTINGS_SECTIONS.map((item) => {
          const Icon = item.icon;
          return (
            <ActionRow
              key={item.id}
              icon={<Icon />}
              label={item.label}
              active={item.id === section}
              onClick={() => onSelect(item.id)}
            />
          );
        })}
      </nav>
    </div>
  );
}

export function Sidebar() {
  const open = useApp((s) => s.sidebarOpen);
  const width = useApp((s) => s.sidebarWidth);
  const setWidth = useApp((s) => s.setSidebarWidth);
  const sessions = useApp((s) => s.sessions);
  const settings = useApp((s) => s.settings);
  const createSession = useApp((s) => s.createSession);
  const openWorkspace = useApp((s) => s.openWorkspace);
  const removeWorkspace = useApp((s) => s.removeWorkspace);
  const reorderWorkspaces = useApp((s) => s.reorderWorkspaces);
  const setLastToggledWorkspace = useApp((s) => s.setLastToggledWorkspace);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const providers = useApp((s) => s.providers);
  const settingsSection = useApp((s) => s.settingsSection);
  const activeId = useApp((s) => s.activeId);
  const closeSettings = useApp((s) => s.closeSettings);
  const shouldReduceMotion = useReducedMotion();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsedRoots, setCollapsedRoots] = useState<Set<string>>(() => {
    if (settings?.collapseProjectGroupsOnStartup === false) return new Set();
    return new Set([
      ...(settings?.openWorkspaceRoots ?? (settings?.workspaceRoot ? [settings.workspaceRoot] : [])),
      ...sessions.flatMap((session) => session.workspaceRoot ? [session.workspaceRoot] : []),
    ]);
  });
  const [projectPendingRemoval, setProjectPendingRemoval] = useState<{ root: string; sessionCount: number } | null>(null);
  const now = Date.now();

  const asideRef = useRef<HTMLElement>(null);

  const filtered = useMemo(() => {
    // Subagent (child) sessions are reached via their parent's task card, not the
    // top-level list.
    const top = sessions.filter((s) => !s.parentID);
    const q = query.trim().toLowerCase();
    return q ? top.filter((s) => s.title.toLowerCase().includes(q)) : top;
  }, [sessions, query]);

  const { projectSessions, chats } = useMemo(() => {
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
    return { projectSessions: byProject, chats: standalone };
  }, [filtered]);

  const projectSessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of sessions) {
      if (!session.parentID && session.workspaceRoot) {
        counts.set(session.workspaceRoot, (counts.get(session.workspaceRoot) ?? 0) + 1);
      }
    }
    return counts;
  }, [sessions]);

  const openRoots = settings?.openWorkspaceRoots ?? (settings?.workspaceRoot ? [settings.workspaceRoot] : []);
  const canLeaveSettings = Boolean(activeId || providers?.connected.length);
  const projects = openRoots.map((root) => ({ root, sessions: projectSessions.get(root) ?? [] }));
  const otherProjects = [...projectSessions.entries()]
    .filter(([root]) => !openRoots.includes(root))
    .map(([root, projectSessions]) => ({ root, sessions: projectSessions }));

  const toggleProject = (root: string) => {
    void setLastToggledWorkspace(root);
    setCollapsedRoots((current) => {
      const next = new Set(current);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  const createChat = async () => {
    const root = newChatWorkspace(useApp.getState());
    await createSession();
    if (!root) return;
    setCollapsedRoots((current) => {
      if (!current.has(root)) return current;
      const next = new Set(current);
      next.delete(root);
      return next;
    });
  };

  const createProjectChat = async (root: string) => {
    await createSession(root);
    setCollapsedRoots((current) => {
      if (!current.has(root)) return current;
      const next = new Set(current);
      next.delete(root);
      return next;
    });
  };

  const requestRemoveProject = (root: string, sessionCount: number) => {
    if (sessionCount === 0) {
      void removeWorkspace(root);
      return;
    }
    setProjectPendingRemoval({ root, sessionCount });
  };

  const confirmRemoveProject = async () => {
    if (!projectPendingRemoval) return;
    await removeWorkspace(projectPendingRemoval.root);
    setProjectPendingRemoval(null);
  };

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

  const sessionsView = (
    <div className="flex h-full flex-col">
      <nav className="app-drag flex flex-col gap-0.5 px-3 pt-1 pb-1">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <ActionRow
              icon={<SquarePen />}
              label="New chat"
              onClick={() => void createChat()}
            />
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => void createSession(null)}>
              <SquarePen className="size-4" /> New standalone chat
              <span className="ml-auto text-xs text-muted-foreground">⌘⇧N</span>
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <ActionRow icon={<FolderOpen />} label="Open project" onClick={() => void openWorkspace()} />
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

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        <Reorder.Group
          axis="y"
          values={openRoots}
          onReorder={(roots) => void reorderWorkspaces(roots)}
          className="m-0 flex list-none flex-col gap-0.5 p-0"
        >
          {projects.map((project) => {
            const collapsed = collapsedRoots.has(project.root);
            return (
              <Reorder.Item
                key={project.root}
                value={project.root}
                transition={{ type: "spring", duration: 0.3, bounce: 0.1 }}
              >
                <ProjectGroup
                  root={project.root}
                  sessions={project.sessions}
                  now={now}
                  collapsed={collapsed}
                  canRemove={openRoots.length > 1}
                  onToggle={() => toggleProject(project.root)}
                  onCreate={() => void createProjectChat(project.root)}
                  onRemove={() => requestRemoveProject(project.root, projectSessionCounts.get(project.root) ?? 0)}
                />
              </Reorder.Item>
            );
          })}
        </Reorder.Group>

        {otherProjects.length > 0 && (
          <div className="mt-4">
            <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">Other projects</div>
            {otherProjects.map((project) => {
              const collapsed = collapsedRoots.has(project.root);
              return (
                <ProjectGroup
                  key={project.root}
                  root={project.root}
                  sessions={project.sessions}
                  now={now}
                  collapsed={collapsed}
                  canRemove={false}
                  onToggle={() => toggleProject(project.root)}
                  onCreate={() => void createProjectChat(project.root)}
                  onRemove={() => {}}
                />
              );
            })}
          </div>
        )}

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
  );

  const settingsView = (
    <SettingsSidebarView
      section={settingsSection}
      onSelect={(section) => useApp.setState({ settingsSection: section })}
      onBack={closeSettings}
      canLeave={canLeaveSettings}
    />
  );

  return (
    <aside
      ref={asideRef}
      className="relative h-full shrink-0 overflow-hidden bg-sidebar backdrop-blur-2xl transition-[max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
      style={{ maxWidth: open ? `${width}px` : "0px" }}
    >
      <div className="flex h-full flex-col" style={{ width }}>
        <TitleBar />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {shouldReduceMotion ? (
            <>
              <motion.div
                className="absolute inset-0"
                animate={{ opacity: settingsOpen ? 0 : 1 }}
                transition={{ duration: 0.12, ease: [0.23, 1, 0.32, 1] }}
                aria-hidden={settingsOpen}
                inert={settingsOpen}
              >
                {sessionsView}
              </motion.div>
              <motion.div
                className="absolute inset-0"
                animate={{ opacity: settingsOpen ? 1 : 0 }}
                transition={{ duration: 0.12, ease: [0.23, 1, 0.32, 1] }}
                aria-hidden={!settingsOpen}
                inert={!settingsOpen}
              >
                {settingsView}
              </motion.div>
            </>
          ) : (
            <motion.div
              initial={false}
              className="flex h-full w-[200%] will-change-transform"
              animate={{ transform: settingsOpen ? "translateX(-50%)" : "translateX(0)" }}
              transition={{ type: "spring", duration: 0.38, bounce: 0.1 }}
            >
              <div className="h-full w-1/2" aria-hidden={settingsOpen} inert={settingsOpen}>
                {sessionsView}
              </div>
              <div className="h-full w-1/2" aria-hidden={!settingsOpen} inert={!settingsOpen}>
                {settingsView}
              </div>
            </motion.div>
          )}
        </div>
      </div>
      <Dialog open={Boolean(projectPendingRemoval)} onOpenChange={(open) => !open && setProjectPendingRemoval(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove {projectPendingRemoval ? projectName(projectPendingRemoval.root) : "project"}?</DialogTitle>
            <DialogDescription>
              {projectPendingRemoval?.sessionCount} {projectPendingRemoval?.sessionCount === 1 ? "session is" : "sessions are"} retained and will appear under Other projects.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setProjectPendingRemoval(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void confirmRemoveProject()}>Remove project</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

function ProjectGroup({
  root,
  sessions,
  now,
  collapsed,
  canRemove,
  onToggle,
  onCreate,
  onRemove,
}: {
  root: string;
  sessions: SessionMeta[];
  now: number;
  collapsed: boolean;
  canRemove: boolean;
  onToggle: () => void;
  onCreate: () => void;
  onRemove: () => void;
}) {
  const shouldReduceMotion = useReducedMotion();
  return (
    <div className="">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            className="app-no-drag flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-sidebar-foreground/80 transition-colors hover:bg-white/5"
          >
            <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{projectName(root)}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onCreate}>
            <SquarePen className="size-4" /> New chat
          </ContextMenuItem>
          {canRemove ? (
            <ContextMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 className="size-4" /> Remove project
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={shouldReduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: shouldReduceMotion ? 0.12 : 0.18, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="ml-3 flex flex-col gap-0.5 pl-2">
              {sessions.map((session) => <SidebarSessionRow key={session.id} session={session} now={now} />)}
              {sessions.length === 0 && <div className="px-2 py-1 text-xs text-muted-foreground">No chats yet</div>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
