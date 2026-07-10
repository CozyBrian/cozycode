import { useTerminalDimensions } from "@opentui/react";
import { syntaxStyle, theme } from "../theme.ts";

export function Diff({ patch }: { patch: string }) {
  const dimensions = useTerminalDimensions();

  return (
    <diff
      diff={patch}
      view={(dimensions.width || 0) > 120 ? "split" : "unified"}
      width="100%"
      fg={theme.text}
      syntaxStyle={syntaxStyle}
      addedBg={theme.diff.addedBg}
      removedBg={theme.diff.removedBg}
      addedSignColor={theme.diff.added}
      removedSignColor={theme.diff.removed}
      lineNumberFg={theme.diff.lineNumber}
      showLineNumbers={true}
      wrapMode="word"
    />
  );
}
