import { ChevronLeft, ChevronRight, PanelBottom, PanelLeft, PanelRight } from "lucide-react";
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

export function TitleControls() {
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const toggleSidebar = useApp((s) => s.toggleSidebar);
  const subagentHistoryIndex = useApp((s) => s.subagentHistoryIndex);
  const subagentHistory = useApp((s) => s.subagentHistory);
  const sessionHistoryIndex = useApp((s) => s.sessionHistoryIndex);
  const sessionHistory = useApp((s) => s.sessionHistory);
  const navigateBack = useApp((s) => s.navigateBack);
  const navigateForward = useApp((s) => s.navigateForward);

  return (
    <div className="flex items-center gap-1 pl-22">
      <IconButton label="Toggle sidebar  ⌘B" onClick={toggleSidebar} active={sidebarOpen}>
        <PanelLeft className="size-4" />
      </IconButton>
      <IconButton
        label="Back  ⌘["
        onClick={navigateBack}
        disabled={subagentHistoryIndex === 0 && sessionHistoryIndex <= 0}
      >
        <ChevronLeft className="size-4" />
      </IconButton>
      <IconButton
        label="Forward  ⌘]"
        onClick={navigateForward}
        disabled={subagentHistoryIndex === subagentHistory.length - 1 && sessionHistoryIndex === sessionHistory.length - 1}
      >
        <ChevronRight className="size-4" />
      </IconButton>
    </div>
  );
}

export function ViewControls() {
  const terminalOpen = useApp((s) => s.terminalOpen);
  const contentPanelOpen = useApp((s) => s.contentPanelOpen);
  const toggleTerminal = useApp((s) => s.toggleTerminal);
  const toggleContentPanel = useApp((s) => s.toggleContentPanel);

  return (
    <div className="flex items-center gap-1 pr-3">
      <IconButton label="Toggle terminal  ⌘J" onClick={toggleTerminal} active={terminalOpen}>
        <PanelBottom className="size-4" />
      </IconButton>
      <IconButton label="Toggle panel  ⌘\\" onClick={toggleContentPanel} active={contentPanelOpen}>
        <PanelRight className="size-4" />
      </IconButton>
    </div>
  );
}

export function TitleBar() {
  return <header className="app-drag flex h-12 w-full shrink-0 items-center px-3" />;
}
