import { useTerminalDimensions } from "@opentui/react";
import { theme } from "../../theme.ts";
import { SHELL_LEADER_BINDINGS, type ShellKeyBinding } from "./ShellHelp.tsx";

export interface WhichKeyProps {
  visible: boolean;
  leaderLabel?: string;
  bindings?: readonly ShellKeyBinding[];
  overlay?: boolean;
}

export function WhichKey({
  visible,
  leaderLabel = "ctrl+x",
  bindings = SHELL_LEADER_BINDINGS,
  overlay = true,
}: WhichKeyProps) {
  const dimensions = useTerminalDimensions();
  if (!visible) return null;
  const columns = dimensions.width >= 100 ? 3 : dimensions.width >= 64 ? 2 : 1;
  const rows = Math.ceil(bindings.length / columns);
  const groups = Array.from({ length: columns }, (_, column) =>
    bindings.slice(column * rows, (column + 1) * rows),
  );

  return (
    <box
      position={overlay ? "absolute" : "relative"}
      left={overlay ? 0 : undefined}
      right={overlay ? 0 : undefined}
      bottom={overlay ? 0 : undefined}
      zIndex={150}
      flexDirection="column"
      backgroundColor={theme.panel}
      border={["top"]}
      borderColor={theme.borderActive}
      paddingX={2}
      paddingY={1}
      flexShrink={0}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.primary}><b>{`${leaderLabel} leader`}</b></text>
        <text fg={theme.muted}>esc cancel</text>
      </box>
      <box flexDirection="row" gap={3} marginTop={1}>
        {groups.map((group, index) => (
          <box key={index} flexDirection="column" flexGrow={1} minWidth={0}>
            {group.map((binding) => (
              <box key={binding.key} flexDirection="row" justifyContent="space-between" gap={1}>
                <text fg={theme.muted} wrapMode="none">{binding.label}</text>
                <text fg={theme.text} flexShrink={0}><b>{binding.key}</b></text>
              </box>
            ))}
          </box>
        ))}
      </box>
    </box>
  );
}
