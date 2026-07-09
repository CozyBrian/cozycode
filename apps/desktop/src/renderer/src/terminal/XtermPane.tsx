import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { cn } from "@/lib/utils";

/**
 * One xterm instance bound to a main-process PTY. Instances for inactive tabs
 * stay mounted but hidden (visibility) and refit when re-shown, since a
 * display:none terminal can't measure itself to fit.
 */
export function XtermPane({ termId, active }: { termId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      allowTransparency: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12.5,
      theme: { background: "rgba(0,0,0,0)", foreground: "#d6dae2", cursor: "#8ab4f8" },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const safeFit = () => {
      try {
        fit.fit();
        void window.cozy.term.resize(termId, term.cols, term.rows);
      } catch {
        // host not measurable yet
      }
    };
    safeFit();

    const onData = term.onData((data) => void window.cozy.term.write(termId, data));
    const offData = window.cozy.term.onData((p) => {
      if (p.termId === termId) term.write(p.data);
    });

    const ro = new ResizeObserver(() => safeFit());
    ro.observe(host);
    // Refit after layout transitions (drawer resize, sidebar toggle) settle.
    const onTransitionEnd = () => safeFit();
    window.addEventListener("transitionend", onTransitionEnd);

    return () => {
      onData.dispose();
      offData();
      ro.disconnect();
      window.removeEventListener("transitionend", onTransitionEnd);
      term.dispose();
    };
  }, [termId]);

  // Refit + focus when this tab becomes active.
  useEffect(() => {
    if (active && fitRef.current && termRef.current) {
      requestAnimationFrame(() => {
        try {
          fitRef.current!.fit();
          void window.cozy.term.resize(termId, termRef.current!.cols, termRef.current!.rows);
          termRef.current!.focus();
        } catch {
          // ignore
        }
      });
    }
  }, [active, termId]);

  return (
    <div
      className={cn("absolute inset-0 px-3 py-2", active ? "visible" : "invisible")}
      ref={hostRef}
    />
  );
}
