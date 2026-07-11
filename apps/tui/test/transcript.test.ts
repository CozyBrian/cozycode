import { test, expect, describe } from "bun:test";
import type { SessionEvent } from "@cozycode/protocol";
import { foldTurn, type RenderItem } from "../src/transcript.ts";

function fold(events: SessionEvent[]): RenderItem[] {
  return events.reduce<RenderItem[]>((items, e) => foldTurn(items, e), []);
}

describe("foldTurn reasoning blocks", () => {
  test("two blocks that reuse one reasoning id keep independent durations", () => {
    // openai-compatible / DeepSeek reuse the id "reasoning-0" for every block.
    const items = fold([
      { type: "reasoning-start", id: "reasoning-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "first" },
      { type: "reasoning-end", id: "reasoning-0", durationMs: 3000 },
      { type: "reasoning-start", id: "reasoning-0" },
      { type: "reasoning-delta", id: "reasoning-0", text: "second" },
      { type: "reasoning-end", id: "reasoning-0", durationMs: 21000 },
    ]);
    const reasoning = items.filter((it): it is Extract<RenderItem, { kind: "reasoning" }> => it.kind === "reasoning");
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0]!.text).toBe("first");
    expect(reasoning[0]!.durationMs).toBe(3000);
    expect(reasoning[1]!.text).toBe("second");
    expect(reasoning[1]!.durationMs).toBe(21000);
    expect(reasoning.every((r) => !r.streaming)).toBe(true);
  });

  test("stops live tool rows when an aborted turn errors", () => {
    const items = fold([
      { type: "tool-call-start", toolCallId: "call-1", toolName: "search", args: { pattern: "needle" } },
      { type: "error", message: "The operation was aborted." },
    ]);

    expect(items[0]).toMatchObject({ kind: "tool", status: "error", result: "Did not complete." });
  });
});
