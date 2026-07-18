import type { ReactNode } from "react";
import { RGBA } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { theme } from "../../theme.ts";

export const SHELL_SIDEBAR_WIDTH = 42;
export const SHELL_WIDE_BREAKPOINT = 120;

export type AppShellSidebarMode = "auto" | "open" | "closed";

export interface AppShellProps {
  children: ReactNode;
  sidebar?: ReactNode;
  /** Auto-inlines above 120, open forces visibility, and closed overrides auto. */
  sidebarMode?: AppShellSidebarMode;
  sidebarKeyboardEnabled?: boolean;
  onCloseSidebar?: () => void;
  overlay?: ReactNode;
}

export function AppShell({
  children,
  sidebar,
  sidebarMode = "auto",
  sidebarKeyboardEnabled = true,
  onCloseSidebar,
  overlay,
}: AppShellProps) {
  const dimensions = useTerminalDimensions();
  const wide = dimensions.width > SHELL_WIDE_BREAKPOINT;
  const showInlineSidebar = Boolean(sidebar) && wide && sidebarMode !== "closed";
  const showOverlaySidebar = Boolean(sidebar) && sidebarMode === "open" && !wide;

  useKeyboard((key) => {
    if (!sidebarKeyboardEnabled || !showOverlaySidebar || key.name !== "escape") return;
    key.stopPropagation();
    onCloseSidebar?.();
  });

  return (
    <box
      position="relative"
      flexDirection="row"
      width="100%"
      height="100%"
      backgroundColor={theme.bg}
    >
      <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column">
        {children}
      </box>
      {showInlineSidebar ? sidebar : null}
      {showOverlaySidebar ? (
        <box
          position="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          zIndex={100}
          alignItems="flex-end"
          backgroundColor={RGBA.fromInts(0, 0, 0, 72)}
          onMouseUp={() => onCloseSidebar?.()}
        >
          <box
            width={SHELL_SIDEBAR_WIDTH}
            height="100%"
            onMouseUp={(event) => event.stopPropagation()}
          >
            {sidebar}
          </box>
        </box>
      ) : null}
      {overlay}
    </box>
  );
}
