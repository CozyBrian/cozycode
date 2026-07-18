import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { RGBA } from "@opentui/core";
import { theme } from "../../theme.ts";

export interface ShellKeyBinding {
  key: string;
  label: string;
}

export const SHELL_DIRECT_BINDINGS: readonly ShellKeyBinding[] = [
  { key: "enter", label: "send message" },
  { key: "shift+enter", label: "insert newline" },
  { key: "tab", label: "toggle plan / build" },
  { key: "esc", label: "stop, cancel, or close" },
  { key: "pgup / pgdn", label: "scroll transcript" },
];

export const SHELL_LEADER_BINDINGS: readonly ShellKeyBinding[] = [
  { key: "n", label: "new session" },
  { key: "l", label: "list sessions" },
  { key: "b", label: "toggle sidebar" },
  { key: "m", label: "switch model" },
  { key: "p", label: "command palette" },
  { key: "u", label: "undo turn" },
  { key: "r", label: "redo turn" },
  { key: "c", label: "commit revert" },
  { key: "g", label: "message timeline" },
  { key: "e", label: "external editor" },
  { key: "?", label: "help" },
  { key: "q", label: "quit" },
];

export interface ShellHelpProps {
  onClose: () => void;
  leaderLabel?: string;
  directBindings?: readonly ShellKeyBinding[];
  leaderBindings?: readonly ShellKeyBinding[];
}

export function ShellHelp({
  onClose,
  leaderLabel = "ctrl+x",
  directBindings = SHELL_DIRECT_BINDINGS,
  leaderBindings = SHELL_LEADER_BINDINGS,
}: ShellHelpProps) {
  const dimensions = useTerminalDimensions();
  useKeyboard((key) => {
    if (key.name !== "escape" && key.name !== "return") return;
    key.stopPropagation();
    onClose();
  });

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={200}
      alignItems="center"
      justifyContent="center"
      backgroundColor={RGBA.fromInts(0, 0, 0, 82)}
    >
      <box
        flexDirection="column"
        width={Math.max(1, Math.min(58, dimensions.width - 4))}
        maxHeight="80%"
        backgroundColor={theme.panel}
        borderStyle="rounded"
        borderColor={theme.borderActive}
        paddingX={2}
        paddingY={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text}><b>Keyboard</b></text>
          <text fg={theme.muted} onMouseUp={onClose}>esc / enter</text>
        </box>
        <scrollbox flexGrow={1} marginTop={1} scrollbarOptions={{ visible: false }}>
          <text fg={theme.primary}>Direct</text>
          {directBindings.map((binding) => <HelpRow key={binding.key} binding={binding} />)}
          <box height={1} />
          <text fg={theme.primary}>{`${leaderLabel} leader`}</text>
          <text fg={theme.muted}>{`Press ${leaderLabel}, release, then choose a key.`}</text>
          {leaderBindings.map((binding) => (
            <HelpRow key={binding.key} binding={{ ...binding, key: `${leaderLabel} ${binding.key}` }} />
          ))}
        </scrollbox>
      </box>
    </box>
  );
}

function HelpRow({ binding }: { binding: ShellKeyBinding }) {
  return (
    <box flexDirection="row">
      <text fg={theme.text}>{binding.key.padEnd(18)}</text>
      <text fg={theme.muted}>{binding.label}</text>
    </box>
  );
}
