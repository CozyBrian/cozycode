import { Settings } from "lucide-react";
import { useApp } from "../store/app-store";

export function SidebarFooter() {
  const openSettings = useApp((s) => s.openSettings);

  return (
    <button
      type="button"
      onClick={() => openSettings()}
      className="app-no-drag flex w-full items-center gap-2.5 border-t border-sidebar-border px-3 py-2.5 text-left text-sm text-sidebar-foreground/85 transition-colors hover:bg-white/6 hover:text-sidebar-foreground"
    >
      <Settings className="size-4 text-muted-foreground" />
      Settings
    </button>
  );
}
