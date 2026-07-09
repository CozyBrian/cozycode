import { ChevronLeft, ChevronRight, PanelLeft, PanelBottom } from "lucide-react";
import { useApp } from "../store/app-store";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function IconButton({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "app-no-drag flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent",
            active && "bg-white/10 text-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function TitleBar() {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const terminalOpen = useApp((s) => s.terminalOpen);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const toggleTerminal = useApp((s) => s.toggleTerminal);

  return (
    <header className="app-drag flex h-12 items-center justify-between border-b border-border/60 px-3">
      {/* Left: clears the native traffic lights, then nav arrows. */}
      <div className="flex items-center gap-1 pl-18">
        <IconButton label="Back" disabled>
          <ChevronLeft className="size-4" />
        </IconButton>
        <IconButton label="Forward" disabled>
          <ChevronRight className="size-4" />
        </IconButton>
      </div>

      {/* Right: panel toggles. */}
      <div className="flex items-center gap-1">
        <IconButton label="Toggle sidebar  ⌘B" onClick={toggleSidebar} active={sidebarOpen}>
          <PanelLeft className="size-4" />
        </IconButton>
        <IconButton label="Toggle terminal  ⌘J" onClick={toggleTerminal} active={terminalOpen}>
          <PanelBottom className="size-4" />
        </IconButton>
      </div>
    </header>
  );
}
