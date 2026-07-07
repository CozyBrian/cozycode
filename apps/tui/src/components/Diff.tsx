import { createTwoFilesPatch } from "diff";
import { syntaxStyle, theme } from "../theme.ts";

export function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const patch = createTwoFilesPatch("before", "after", oldText, newText, "", "", { context: 3 });

  return (
    <diff
      diff={patch}
      view="unified"
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
