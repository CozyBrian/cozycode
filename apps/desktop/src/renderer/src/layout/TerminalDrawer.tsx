import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { useApp } from "../store/app-store";
import { XtermPane } from "../terminal/XtermPane";
import { cn } from "@/lib/utils";

function useClock(): string {
  const [now, setNow] = useState(() => new Date().toLocaleTimeString());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

export function TerminalDrawer() {
  const open = useApp((s) => s.terminalOpen);
  const height = useApp((s) => s.terminalHeight);
  const setHeight = useApp((s) => s.setTerminalHeight);
  const tabs = useApp((s) => s.termTabs);
  const activeTermId = useApp((s) => s.activeTermId);
  const setActiveTerm = useApp((s) => s.setActiveTerm);
  const closeTerm = useApp((s) => s.closeTerm);
  const newTerminal = useApp((s) => s.newTerminal);
  const toggleTerminal = useApp((s) => s.toggleTerminal);
  const clock = useClock();

  // Ensure at least one shell exists whenever the drawer opens.
  useEffect(() => {
    if (open && tabs.length === 0) void newTerminal();
  }, [open, tabs.length, newTerminal]);

  const dragging = useRef(false);
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true;
      const startY = e.clientY;
      const startH = height;
      const onMove = (ev: PointerEvent) => {
        if (dragging.current) setHeight(startH + (startY - ev.clientY));
      };
      const onUp = () => {
        dragging.current = false;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [height, setHeight],
  );

  if (!open) return null;

  return (
    <div
      className="relative flex shrink-0 flex-col border-t border-border bg-surface-content backdrop-blur-2xl"
      style={{ height }}
    >
      {/* Resize handle */}
      <div
        onPointerDown={onPointerDown}
        className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
      />
      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-border/60 px-2 py-1">
        {tabs.map((t) => (
          <div
            key={t.id}
            onClick={() => setActiveTerm(t.id)}
            className={cn(
              "group flex items-center gap-2 rounded-md px-2.5 py-1 text-xs",
              t.id === activeTermId
                ? "bg-white/10 text-foreground"
                : "text-muted-foreground hover:bg-white/5",
            )}
          >
            <span>{t.title}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeTerm(t.id);
              }}
              className="flex size-3.5 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-white/15 hover:text-foreground group-hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => void newTerminal()}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-white/8 hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{clock}</span>
        <button
          type="button"
          onClick={toggleTerminal}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-white/8 hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
      {/* Panes */}
      <div className="relative min-h-0 flex-1">
        {tabs.map((t) => (
          <XtermPane key={t.id} termId={t.id} active={t.id === activeTermId} />
        ))}
      </div>
    </div>
  );
}
