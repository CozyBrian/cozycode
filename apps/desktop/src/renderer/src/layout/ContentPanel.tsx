import { useCallback, useRef } from "react";
import { FileDiff, GitBranch, LayoutDashboard } from "lucide-react";
import { useApp, type ContentPanelTab } from "../store/app-store";
import { OverviewPane } from "../content/OverviewPane";
import { DiffsPane } from "../content/DiffsPane";
import { GitPane } from "../content/GitPane";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const TABS: { id: ContentPanelTab; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <LayoutDashboard className="size-4" /> },
  { id: "diffs", label: "Diffs", icon: <FileDiff className="size-4" /> },
  { id: "git", label: "Git", icon: <GitBranch className="size-4" /> },
];

function TabButton({ id, label, icon }: { id: ContentPanelTab; label: string; icon: React.ReactNode }) {
  const active = useApp((s) => s.contentPanelTab === id);
  const setTab = useApp((s) => s.setContentPanelTab);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => setTab(id)}
          className={cn(
            "app-no-drag flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground",
            active && "bg-white/10 text-foreground",
          )}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PaneBody() {
  const tab = useApp((s) => s.contentPanelTab);
  if (tab === "diffs") return <DiffsPane />;
  if (tab === "git") return <GitPane />;
  return <OverviewPane />;
}

export function ContentPanel() {
  const open = useApp((s) => s.contentPanelOpen);
  const width = useApp((s) => s.contentPanelWidth);
  const setWidth = useApp((s) => s.setContentPanelWidth);
  const sidebarWidth = useApp((s) => s.sidebarWidth);

  const asideRef = useRef<HTMLElement>(null);

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const el = asideRef.current;
      if (el) el.style.transition = "none";
      const startX = e.clientX;
      const startW = width;
      const onMove = (ev: PointerEvent) => {
        const maxW = Math.max(200, window.innerWidth - sidebarWidth - 300);
        setWidth(Math.min(maxW, startW + (startX - ev.clientX)));
      };
      const onUp = () => {
        if (el) el.style.transition = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [width, setWidth, sidebarWidth],
  );

  return (
    <aside
      ref={asideRef}
      className="relative h-full shrink-0 overflow-hidden bg-surface-content backdrop-blur-2xl transition-[max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
      style={{ maxWidth: open ? `${width}px` : "0px" }}
    >
      <div className="flex h-full flex-col" style={{ width }}>
        <header className="app-drag flex h-12 shrink-0 items-center gap-1 border-b border-border/60 px-3">
          {TABS.map((t) => (
            <TabButton key={t.id} {...t} />
          ))}
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          <PaneBody />
        </div>
      </div>
      {/* Resize handle */}
      {open ? (
        <div
          onPointerDown={onResizeStart}
          className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
        />
      ) : null}
      {/* Border sits inside the clippable area so it disappears when collapsed */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-px bg-border" />
    </aside>
  );
}
