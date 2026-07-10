import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";

function patchInput(path: string, patch: string): string {
  if (/^(diff --git|Index:|--- )/m.test(patch)) return patch;
  return `Index: ${path}\n===================================================================\n--- ${path}\t\n+++ ${path}\t\n${patch}`;
}

export function ToolDiff({ path, patch }: { path: string; patch: string }) {
  const fileDiff = useMemo(() => {
    try {
      return parsePatchFiles(patchInput(path, patch))[0]?.files[0];
    } catch {
      return undefined;
    }
  }, [path, patch]);

  if (!fileDiff) {
    return <pre className="selectable overflow-x-auto p-3 font-mono text-xs leading-relaxed text-muted-foreground">{patch}</pre>;
  }

  return (
    <FileDiff
      fileDiff={fileDiff}
      options={{
        theme: "pierre-dark",
        diffStyle: "unified",
        diffIndicators: "bars",
        overflow: "wrap",
        disableFileHeader: true,
        hunkSeparators: "line-info-basic",
        lineDiffType: "word-alt",
        lineHoverHighlight: "both",
        maxLineDiffLength: 1000,
        tokenizeMaxLineLength: 1000,
      }}
    />
  );
}
