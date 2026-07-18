import { describe, expect, test } from "bun:test";
import {
  createHistoryNavigationState,
  navigatePromptHistory,
  type HistoryNavigationResult,
  type PromptHistoryEntry,
} from "../src/prompt/index.ts";

const entries: PromptHistoryEntry[] = [{ text: "one" }, { text: "two", mode: "shell" }];

function replace(result: HistoryNavigationResult): Extract<HistoryNavigationResult, { action: "replace" }> {
  expect(result.action).toBe("replace");
  return result as Extract<HistoryNavigationResult, { action: "replace" }>;
}

describe("history navigation", () => {
  test("enters history only at the start boundary", () => {
    const state = createHistoryNavigationState();
    expect(navigatePromptHistory({ state, entries, direction: -1, current: { text: "draft" }, cursor: 2 }).action).toBe("none");
    expect(
      navigatePromptHistory({
        state,
        entries,
        direction: -1,
        current: { text: "draft" },
        cursor: 2,
        atFirstLine: true,
      }),
    ).toEqual({ action: "cursor", state, cursor: 0 });

    const latest = replace(navigatePromptHistory({ state, entries, direction: -1, current: { text: "draft" }, cursor: 0 }));
    expect(latest.entry).toEqual({ text: "two", mode: "shell" });
    expect(latest.state).toEqual({ index: 1, draft: { text: "draft" } });
    expect(latest.cursor).toBe(0);
  });

  test("walks older/newer entries and restores the captured draft", () => {
    const latest = replace(
      navigatePromptHistory({
        state: createHistoryNavigationState(),
        entries,
        direction: -1,
        current: { text: "draft" },
        cursor: 0,
      }),
    );
    const older = replace(
      navigatePromptHistory({ state: latest.state, entries, direction: -1, current: latest.entry, cursor: 0 }),
    );
    expect(older.entry.text).toBe("one");

    const newer = replace(
      navigatePromptHistory({ state: older.state, entries, direction: 1, current: older.entry, cursor: 3 }),
    );
    expect(newer.entry.text).toBe("two");
    expect(newer.cursor).toBe(3);

    const draft = replace(
      navigatePromptHistory({ state: newer.state, entries, direction: 1, current: newer.entry, cursor: 3 }),
    );
    expect(draft.entry).toEqual({ text: "draft" });
    expect(draft.state.index).toBeNull();
    expect(draft.cursor).toBe(5);
  });

  test("does not navigate down away from the end boundary", () => {
    const latest = replace(
      navigatePromptHistory({
        state: createHistoryNavigationState(),
        entries,
        direction: -1,
        current: { text: "" },
        cursor: 0,
      }),
    );
    expect(
      navigatePromptHistory({ state: latest.state, entries, direction: 1, current: latest.entry, cursor: 1 }).action,
    ).toBe("none");
    expect(
      navigatePromptHistory({
        state: latest.state,
        entries,
        direction: 1,
        current: latest.entry,
        cursor: 1,
        atLastLine: true,
      }),
    ).toEqual({ action: "cursor", state: latest.state, cursor: 3 });
  });

  test("preserves edited history and active selections", () => {
    const latest = replace(
      navigatePromptHistory({
        state: createHistoryNavigationState(),
        entries,
        direction: -1,
        current: { text: "" },
        cursor: 0,
      }),
    );
    expect(
      navigatePromptHistory({ state: latest.state, entries, direction: -1, current: { text: "edited" }, cursor: 0 }).action,
    ).toBe("none");
    expect(
      navigatePromptHistory({
        state: createHistoryNavigationState(),
        entries,
        direction: -1,
        current: { text: "draft" },
        cursor: 0,
        selectionStart: 0,
        selectionEnd: 2,
      }).action,
    ).toBe("none");
  });

  test("accepts editor-specific cursor measurements", () => {
    const state = createHistoryNavigationState();
    const wide = [{ text: "中文" }];
    const latest = replace(
      navigatePromptHistory({ state, entries: wide, direction: -1, current: { text: "" }, cursor: 0, measure: Bun.stringWidth }),
    );
    const draft = replace(
      navigatePromptHistory({
        state: latest.state,
        entries: wide,
        direction: 1,
        current: latest.entry,
        cursor: Bun.stringWidth("中文"),
        measure: Bun.stringWidth,
      }),
    );
    expect(draft.cursor).toBe(0);
  });
});
