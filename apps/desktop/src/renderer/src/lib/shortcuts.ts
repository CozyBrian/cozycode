import { useEffect } from "react";
import { useApp } from "../store/app-store";

/**
 * Global keyboard shortcuts. ⌘P / ⌘T are reserved for the Files / Browser rail
 * stubs, so the sidebar uses ⌘B and the terminal drawer ⌘J (VS Code convention).
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) return;
      const key = e.key.toLowerCase();
      const s = useApp.getState();
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
