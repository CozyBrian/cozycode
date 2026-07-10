import { useCallback, useRef } from "react";
import { useApp } from "../store/app-store";

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
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No content
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
