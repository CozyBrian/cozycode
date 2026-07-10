import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
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
  const shouldReduceMotion = useReducedMotion();

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

  const transition = useMemo(
    () =>
      open
        ? { type: "spring" as const, duration: 0.5, bounce: 0.2 }
        : { duration: 0.25, ease: [0.23, 1, 0.32, 1] as [number, number, number, number] },
    [open],
  );

  return (
    <div
      className="shrink-0 overflow-hidden transition-[max-height]"
      style={{
        maxHeight: open ? `${height}px` : "0px",
        transitionDuration: open ? "500ms" : "300ms",
        transitionTimingFunction: open
          ? "cubic-bezier(0.32, 0.72, 0, 1)"
          : "cubic-bezier(0.77, 0, 0.175, 1)",
      }}
    >
      <motion.div
        animate={
          shouldReduceMotion
            ? { opacity: open ? 1 : 0 }
            : { y: open ? 0 : "100%", opacity: open ? 1 : 0 }
        }
        transition={transition}
        className="relative flex flex-col border-t border-border bg-surface-content backdrop-blur-2xl"
        style={{ height }}
      >
        {/* Resize handle */}
        {open ? (
          <div
            onPointerDown={onPointerDown}
            className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
          />
        ) : null}
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
      </motion.div>
    </div>
  );
}
