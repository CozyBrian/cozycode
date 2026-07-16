import { useEffect } from "react";
import { cycleEffort, effortsForModel } from "@cozycode/commands";
import { useApp } from "../store/app-store";

/**
 * Global keyboard shortcuts. ⌘P / ⌘T are reserved for the Files / Browser rail
 * stubs, so the sidebar uses ⌘B and the terminal drawer ⌘J (VS Code convention).
 * ⌘⇧T cycles reasoning effort (⌘T alone stays reserved); ⌘[/⌘] navigate history.
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      const s = useApp.getState();
      // ⌘⇧T cycles reasoning effort; handled before the shift-guarded cases.
      if (key === "t" && e.shiftKey) {
        e.preventDefault();
        const efforts = effortsForModel(s.providers ?? { all: [], connected: [] }, s.model);
        if (efforts.length > 0) s.setEffort(cycleEffort(s.effort, efforts));
        return;
      }
      if (key === "n" && e.shiftKey) {
        e.preventDefault();
        void s.createSession(null);
        return;
      }
      // The remaining shortcuts are single-modifier; ignore shifted variants so
      // shifted combos don't double-fire.
      if (e.shiftKey) return;
      switch (key) {
        case "b":
          e.preventDefault();
          s.toggleSidebar();
          break;
        case "j":
          e.preventDefault();
          s.toggleTerminal();
          break;
        case "\\":
          e.preventDefault();
          s.toggleContentPanel();
          break;
        case "n":
          e.preventDefault();
          void s.createSession();
          break;
        case ",":
          e.preventDefault();
          s.openSettings();
          break;
        case "[":
          e.preventDefault();
          s.navigateBack();
          break;
        case "]":
          e.preventDefault();
          s.navigateForward();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
