import { useMemo } from "react";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useApp } from "../store/app-store";
import { changeCounts } from "../components/tool-presentation";

const DIFF_OPTIONS = {
  theme: "pierre-dark",
  diffStyle: "unified",
  diffIndicators: "bars",
  overflow: "wrap",
  disableFileHeader: false,
  hunkSeparators: "line-info-basic",
  lineDiffType: "word-alt",
  lineHoverHighlight: "both",
  maxLineDiffLength: 1000,
  tokenizeMaxLineLength: 1000,
} as const;

/** Ensure a headerless patch parses (mirrors ToolDiff's normalization). */
function patchInput(path: string, patch: string): string {
  if (/^(diff --git|Index:|--- )/m.test(patch)) return patch;
  return `Index: ${path}\n===================================================================\n--- ${path}\t\n+++ ${path}\t\n${patch}`;
}

export function DiffsPane() {
  const selected = useApp((s) => s.selectedDiff);

  const files = useMemo(() => {
    if (!selected) return [];
    try {
      return parsePatchFiles(patchInput(selected.path, selected.patch)).flatMap((p) => p.files);
    } catch {
      return [];
    }
  }, [selected]);

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        Select a file to view its diff.
      </div>
    );
  }

  const counts = changeCounts(selected.patch);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
          {selected.path}
        </span>
        <span className="shrink-0 font-mono text-xs">
          <span className="text-emerald-400">+{counts.additions}</span>{" "}
          <span className="text-destructive">-{counts.deletions}</span>
        </span>
      </div>
      <div className="content-panel-scroll selectable min-h-0 flex-1 overflow-auto">
        {files.length > 0 ? (
          files.map((fileDiff, i) => <FileDiff key={i} fileDiff={fileDiff} options={DIFF_OPTIONS} />)
        ) : (
          <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-muted-foreground">
            {selected.patch || "No changes."}
          </pre>
        )}
      </div>
    </div>
  );
}
