import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@cozycode/protocol";
import { changeCounts, shellOutput, toolLabel, type ToolItem } from "../src/renderer/src/components/tool-presentation.ts";
import { foldEvent } from "../src/renderer/src/transcript.ts";

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    id: "tool-1",
    kind: "tool",
    toolCallId: "call-1",
    toolName: "search",
    args: { pattern: "needle", path: "src" },
    status: "done",
    ...overrides,
  };
}

describe("desktop tool presentation", () => {
  test("retains file diff metadata from completed tool events", () => {
    const started: SessionEvent = {
      type: "tool-call-start",
      toolCallId: "call-1",
      toolName: "edit_file",
      args: { path: "src/app.ts" },
    };
    const completed: SessionEvent = {
      type: "tool-result",
      toolCallId: "call-1",
      result: { replacements: 1 },
      isError: false,
      metadata: { diff: "@@ -1 +1 @@\n-before\n+after" },
    };

    const item = foldEvent(foldEvent([], started), completed)[0];
    expect(item).toMatchObject({ kind: "tool", status: "done", metadata: completed.metadata });
  });

  test("stops live tool cards when an aborted turn errors", () => {
    const items = [
      { type: "tool-call-start", toolCallId: "call-1", toolName: "search", args: { pattern: "needle" } },
      { type: "error", message: "The operation was aborted." },
    ].reduce<ReturnType<typeof foldEvent>>((current, event) => foldEvent(current, event), []);

    expect(items[0]).toMatchObject({ kind: "tool", status: "error", result: "Did not complete." });
  });

  test("labels searches with their result count", () => {
    expect(toolLabel(tool({ result: { matches: ["a", "b"] } }))).toBe('Grep "needle" in src (2 matches)');
  });

  test("normalizes shell output and counts changed patch lines", () => {
    expect(shellOutput({ stdout: "one\r\ntwo", stderr: "three" })).toBe("one\ntwo\nthree");
    expect(changeCounts("--- a/file\n+++ b/file\n-old\n+new\n unchanged")).toEqual({ additions: 1, deletions: 1 });
  });

  test("tracks subagent tool counts without rescanning its transcript", () => {
    const items = [
      { type: "tool-call-start", toolCallId: "task-1", toolName: "task", args: {} },
      {
        type: "subagent-start",
        toolCallId: "task-1",
        sessionId: "child-1",
        agent: "explore",
        description: "Inspect files",
      },
      {
        type: "subagent-event",
        toolCallId: "task-1",
        sessionId: "child-1",
        event: { type: "tool-call-start", toolCallId: "read-1", toolName: "read_file", args: {} },
      },
      {
        type: "subagent-event",
        toolCallId: "task-1",
        sessionId: "child-1",
        event: { type: "text-delta", text: "done" },
      },
    ].reduce<ReturnType<typeof foldEvent>>(
      (current, event) => foldEvent(current, event as SessionEvent),
      [],
    );

    expect(items[0]).toMatchObject({ subagent: { toolCount: 1 } });
  });
});
