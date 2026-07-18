import { promptHistoryEntriesEqual, type PromptHistoryEntry } from "./history.ts";

export interface HistoryNavigationState<Data = unknown> {
  readonly index: number | null;
  readonly draft?: PromptHistoryEntry<Data>;
}

export interface HistoryNavigationInput<Data = unknown> {
  state: HistoryNavigationState<Data>;
  entries: readonly PromptHistoryEntry<Data>[];
  direction: -1 | 1;
  current: PromptHistoryEntry<Data>;
  cursor: number;
  selectionStart?: number;
  selectionEnd?: number;
  /** Lets a first Up/Down press snap within the first/last visual line. */
  atFirstLine?: boolean;
  atLastLine?: boolean;
  measure?: (text: string) => number;
}

export type HistoryNavigationResult<Data = unknown> =
  | { action: "none"; state: HistoryNavigationState<Data> }
  | { action: "cursor"; state: HistoryNavigationState<Data>; cursor: number }
  | {
      action: "replace";
      state: HistoryNavigationState<Data>;
      entry: PromptHistoryEntry<Data>;
      cursor: number;
    };

export function createHistoryNavigationState<Data = unknown>(): HistoryNavigationState<Data> {
  return { index: null };
}

export function resetHistoryNavigation<Data = unknown>(): HistoryNavigationState<Data> {
  return createHistoryNavigationState<Data>();
}

export function navigatePromptHistory<Data>(input: HistoryNavigationInput<Data>): HistoryNavigationResult<Data> {
  if (input.entries.length === 0) return { action: "none", state: input.state };
  const selectionStart = input.selectionStart ?? input.cursor;
  const selectionEnd = input.selectionEnd ?? input.cursor;
  if (selectionStart !== selectionEnd) return { action: "none", state: input.state };

  const measure = input.measure ?? ((text: string) => text.length);
  const end = measure(input.current.text);
  if (input.direction === -1 && input.cursor !== 0) {
    if (input.atFirstLine) return { action: "cursor", state: input.state, cursor: 0 };
    return { action: "none", state: input.state };
  }
  if (input.direction === 1 && input.cursor !== end) {
    if (input.atLastLine) return { action: "cursor", state: input.state, cursor: end };
    return { action: "none", state: input.state };
  }

  if (input.state.index === null) {
    if (input.direction === 1) return { action: "none", state: input.state };
    const index = input.entries.length - 1;
    return {
      action: "replace",
      state: { index, draft: cloneEntry(input.current) },
      entry: cloneEntry(input.entries[index]!),
      cursor: 0,
    };
  }

  const expected = input.entries[input.state.index];
  if (!expected || !promptHistoryEntriesEqual(expected, input.current)) {
    return { action: "none", state: input.state };
  }

  const index = input.state.index + input.direction;
  if (index < 0) return { action: "none", state: input.state };
  if (index >= input.entries.length) {
    const draft = cloneEntry(input.state.draft ?? { text: "" });
    return {
      action: "replace",
      state: { index: null },
      entry: draft,
      cursor: measure(draft.text),
    };
  }

  const entry = cloneEntry(input.entries[index]!);
  return {
    action: "replace",
    state: { ...input.state, index },
    entry,
    cursor: input.direction === -1 ? 0 : measure(entry.text),
  };
}

function cloneEntry<Data>(entry: PromptHistoryEntry<Data>): PromptHistoryEntry<Data> {
  return { ...entry };
}
