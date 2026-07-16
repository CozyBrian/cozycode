import { isContextTool, type ToolItem } from "../components/tool-presentation.ts";
import type { TranscriptItem } from "../transcript.ts";

export type TranscriptRow =
  | { key: string; kind: "item"; item: TranscriptItem }
  | { key: string; kind: "context"; items: ToolItem[] };

/** Group adjacent context reads/searches into stable virtual-list rows. */
export function transcriptRows(items: TranscriptItem[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const item of items) {
    const previous = rows.at(-1);
    if (isContextTool(item) && previous?.kind === "context") {
      previous.items.push(item);
    } else if (isContextTool(item)) {
      rows.push({ key: item.id, kind: "context", items: [item] });
    } else {
      rows.push({ key: item.id, kind: "item", item });
    }
  }
  return rows;
}
