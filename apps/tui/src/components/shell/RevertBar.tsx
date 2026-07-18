import { useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../../theme.ts";

export interface RevertBarProps {
  hiddenTurnCount: number;
  onRedo?: () => void;
  onCommit?: () => void;
  keyboardEnabled?: boolean;
}

export function RevertBar({
  hiddenTurnCount,
  onRedo,
  onCommit,
  keyboardEnabled = true,
}: RevertBarProps) {
  const leaderAt = useRef(0);

  useKeyboard((key) => {
    if (!keyboardEnabled || hiddenTurnCount <= 0) return;
    if (key.ctrl && key.name === "x") {
      leaderAt.current = Date.now();
      return;
    }
    if (!leaderAt.current || Date.now() - leaderAt.current > 2_000) {
      leaderAt.current = 0;
      return;
    }
    leaderAt.current = 0;
    if (key.name === "r" && onRedo) {
      key.stopPropagation();
      onRedo();
    } else if (key.name === "c" && onCommit) {
      key.stopPropagation();
      onCommit();
    }
  });

  if (hiddenTurnCount <= 0) return null;
  const turnLabel = hiddenTurnCount === 1 ? "turn" : "turns";
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      gap={2}
      flexShrink={0}
      backgroundColor={theme.panel}
      border={["left"]}
      borderColor={theme.warning}
      paddingX={2}
      paddingY={1}
    >
      <box flexDirection="column">
        <text fg={theme.warning}><b>{`${hiddenTurnCount} ${turnLabel} hidden`}</b></text>
        <text fg={theme.muted}>Continue to replace the hidden future, or commit this point.</text>
      </box>
      <box flexDirection="row" gap={2} flexShrink={0}>
        <RevertAction label="redo" shortcut="ctrl+x r" onTrigger={onRedo} />
        <RevertAction label="commit" shortcut="ctrl+x c" onTrigger={onCommit} />
      </box>
    </box>
  );
}

function RevertAction({ label, shortcut, onTrigger }: { label: string; shortcut: string; onTrigger?: () => void }) {
  return (
    <box id={`shell-revert-${label}`} onMouseUp={onTrigger}>
      <text fg={theme.text}>{label}</text>
      <text fg={theme.muted}>{` ${shortcut}`}</text>
    </box>
  );
}
