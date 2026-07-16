import { describe, expect, test } from "bun:test";
import { transcriptRows } from "../src/renderer/src/chat/transcript-rows.ts";
import type { TranscriptItem } from "../src/renderer/src/transcript.ts";

describe("virtual transcript rows", () => {
  test("groups adjacent context tools under the first stable item key", () => {
    const items: TranscriptItem[] = [
      { id: "user-1", kind: "user", text: "inspect this" },
      {
        id: "read-1",
        kind: "tool",
        toolCallId: "call-1",
        toolName: "read_file",
        args: { path: "a.ts" },
        status: "done",
      },
      {
        id: "search-1",
        kind: "tool",
        toolCallId: "call-2",
        toolName: "search",
        args: { pattern: "needle" },
        status: "done",
      },
      { id: "assistant-1", kind: "assistant", text: "Found it.", streaming: false },
    ];

    const rows = transcriptRows(items);

    expect(rows.map((row) => row.key)).toEqual(["user-1", "read-1", "assistant-1"]);
    expect(rows[1]).toMatchObject({ kind: "context", items: [items[1], items[2]] });
    expect(rows[2]).toMatchObject({ kind: "item", item: items[3] });
  });

  test("starts a new group after a non-context row", () => {
    const contextTool = (id: string): TranscriptItem => ({
      id,
      kind: "tool",
      toolCallId: id,
      toolName: "search",
      args: {},
      status: "done",
    });
    const items: TranscriptItem[] = [
      contextTool("search-1"),
      { id: "assistant-1", kind: "assistant", text: "One", streaming: false },
      contextTool("search-2"),
    ];

    expect(transcriptRows(items).map((row) => row.key)).toEqual([
      "search-1",
      "assistant-1",
      "search-2",
    ]);
  });
});
