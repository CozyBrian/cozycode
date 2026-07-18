import { useEffect, useMemo, useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { theme } from "../theme.ts";

export interface SelectItem<T> {
  value: T;
  title: string;
  description?: string;
  category?: string;
  /** Marks the currently-active value (rendered with a ● gutter). */
  current?: boolean;
}

interface Props<T> {
  title: string;
  options: SelectItem<T>[];
  placeholder?: string;
  /** Extra status line under the title (e.g. "loading…"). */
  hint?: string;
  onSelect: (value: T) => void;
  onCancel: () => void;
  width?: number;
  maxVisible?: number;
}

type Row<T> =
  | { kind: "header"; label: string }
  | { kind: "option"; option: SelectItem<T>; index: number };

/**
 * Reusable searchable list dialog: a focused filter input over a scrollable,
 * optionally category-grouped list with keyboard navigation. Ported from
 * opencode's ui/dialog-select. Powers the model selector.
 */
export function DialogSelect<T>({
  title,
  options,
  placeholder = "Search…",
  hint,
  onSelect,
  onCancel,
  width = 60,
  maxVisible = 12,
}: Props<T>) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => Math.max(0, options.findIndex((option) => option.current)));
  const scroll = useRef<ScrollBoxRenderable | null>(null);

  const filtered = useMemo(() => {
    const scored = options
      .map((option) => ({ option, score: fuzzyScore(query, option.title) }))
      .filter((entry) => entry.score !== null);
    if (query) scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return scored.map((entry) => entry.option);
  }, [options, query]);

  // Build display rows (category headers interleaved) and remember the row
  // position of each selectable option so we can keep the selection in view.
  const { rows, optionRows } = useMemo(() => {
    const hasCategories = filtered.some((o) => o.category);
    const built: Row<T>[] = [];
    const optionRowYs: number[] = [];
    let lastCategory: string | undefined;
    let optionIndex = 0;
    for (const option of filtered) {
      if (hasCategories && option.category !== lastCategory) {
        lastCategory = option.category;
        built.push({ kind: "header", label: option.category ?? "Other" });
      }
      optionRowYs.push(built.length);
      built.push({ kind: "option", option, index: optionIndex });
      optionIndex += 1;
    }
    return { rows: built, optionRows: optionRowYs };
  }, [filtered]);

  // Clamp selection whenever the filtered set changes.
  useEffect(() => {
    setSelected((s) => Math.min(Math.max(0, s), Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const listHeight = Math.min(Math.max(rows.length, 1), maxVisible);

  // Keep the selected row within the scroll viewport.
  useEffect(() => {
    const box = scroll.current;
    if (!box || filtered.length === 0) return;
    const rowY = optionRows[selected] ?? 0;
    if (rowY < box.scrollTop) box.scrollTo(rowY);
    else if (rowY >= box.scrollTop + listHeight) box.scrollTo(rowY - listHeight + 1);
  }, [selected, optionRows, filtered.length, listHeight]);

  const move = (delta: number) => {
    if (filtered.length === 0) return;
    setSelected((s) => (s + delta + filtered.length) % filtered.length);
  };

  useKeyboard((key) => {
    const handled = ["escape", "up", "down", "pageup", "pagedown", "home", "end", "return", "kpenter"]
      .includes(key.name);
    if (!handled) return;
    key.preventDefault();
    key.stopPropagation();
    if (key.name === "escape") return onCancel();
    if (key.name === "up") return move(-1);
    if (key.name === "down") return move(1);
    if (key.name === "pageup") return setSelected((s) => Math.max(0, s - listHeight));
    if (key.name === "pagedown")
      return setSelected((s) => Math.max(0, Math.min(filtered.length - 1, s + listHeight)));
    if (key.name === "home") return setSelected(0);
    if (key.name === "end") return setSelected(Math.max(0, filtered.length - 1));
    if (key.name === "return" || key.name === "kpenter") {
      const option = filtered[selected];
      if (option) onSelect(option.value);
    }
  });

  return (
    <box justifyContent="center" marginY={1}>
      <box
        flexDirection="column"
        width={width}
        borderStyle="rounded"
        borderColor={theme.borderActive}
        backgroundColor={theme.panel}
        paddingX={2}
        paddingY={1}
      >
        <text fg={theme.text}>{title}</text>
        <box flexDirection="row" marginTop={1}>
          <text fg={theme.primary}>{"› "}</text>
          <input
            focused
            placeholder={placeholder}
            onInput={(value: string) => {
              setQuery(value);
              setSelected(0);
            }}
          />
        </box>
        {hint ? <text fg={theme.muted}>{hint}</text> : null}
        <box marginTop={1} height={listHeight}>
          <scrollbox
            ref={(r: ScrollBoxRenderable | null) => {
              scroll.current = r;
            }}
            flexGrow={1}
            scrollbarOptions={{ visible: false }}
          >
            {rows.length === 0 ? (
              <text fg={theme.muted}>No matches</text>
            ) : (
              rows.map((row, i) =>
                row.kind === "header" ? (
                  <text key={`h${i}`} fg={theme.muted}>
                    {row.label}
                  </text>
                ) : (
                  <OptionRow
                    key={`o${row.index}`}
                    option={row.option}
                    active={row.index === selected}
                    id={`dialog-select-option-${row.index}`}
                    width={width - 6}
                    onHover={() => setSelected(row.index)}
                    onSelect={() => onSelect(row.option.value)}
                  />
                ),
              )
            )}
          </scrollbox>
        </box>
        <box flexDirection="row" justifyContent="space-between" marginTop={1}>
          <text fg={theme.muted}>↑↓ select · enter confirm · esc cancel</text>
          <text fg={theme.muted}>{filtered.length} items</text>
        </box>
      </box>
    </box>
  );
}

function OptionRow<T>({
  option,
  active,
  id,
  width,
  onHover,
  onSelect,
}: {
  option: SelectItem<T>;
  active: boolean;
  id: string;
  width: number;
  onHover: () => void;
  onSelect: () => void;
}) {
  const fg = active ? theme.bg : theme.text;
  return (
    <box
      id={id}
      flexDirection="row"
      width={width}
      backgroundColor={active ? theme.primary : undefined}
      onMouseOver={onHover}
      onMouseDown={onHover}
      onMouseUp={onSelect}
    >
      <text fg={option.current ? (active ? theme.bg : theme.primary) : fg}>
        {option.current ? "● " : "  "}
      </text>
      <text fg={fg}>{option.title}</text>
      {option.description ? (
        <text fg={active ? theme.bg : theme.muted}>{`  ${option.description}`}</text>
      ) : null}
    </box>
  );
}

/**
 * Lightweight subsequence fuzzy match: returns null when `needle` is not a
 * subsequence of `haystack`, otherwise a score that rewards contiguous and
 * word-start matches (higher is better). Empty needle matches everything.
 */
function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let score = 0;
  let hi = 0;
  let prevMatch = -2;
  for (let ni = 0; ni < n.length; ni++) {
    const ch = n.charAt(ni);
    const found = h.indexOf(ch, hi);
    if (found === -1) return null;
    if (found === prevMatch + 1) score += 5; // contiguous
    if (found === 0 || /[\s/\-_.:]/.test(h.charAt(found - 1))) score += 3; // word start
    score += 1;
    prevMatch = found;
    hi = found + 1;
  }
  // Prefer shorter haystacks (tighter matches).
  return score - haystack.length * 0.01;
}
