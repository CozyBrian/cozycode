export interface PasteSummaryOptions {
  summarize?: boolean;
  minimumLines?: number;
  minimumCharacters?: number;
  placeholder?: (input: { lineCount: number; characterCount: number }) => string;
}

export interface PreparedPaste {
  normalized: string;
  insertion: string;
  lineCount: number;
  summarized: boolean;
}

export interface PastedTextPlaceholder {
  id: string;
  placeholder: string;
  content: string;
  start: number;
  end: number;
  lineCount: number;
}

export interface InsertPasteOptions extends PasteSummaryOptions {
  id?: string;
}

export interface InsertPasteResult {
  text: string;
  cursor: number;
  normalized: string;
  placeholder?: PastedTextPlaceholder;
}

export interface ExpandedPasteResult {
  text: string;
  unresolved: readonly string[];
}

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function preparePastedText(text: string, options: PasteSummaryOptions = {}): PreparedPaste {
  const normalized = normalizePastedText(text);
  const meaningful = normalized.trim();
  const lineCount = meaningful ? meaningful.split("\n").length : 0;
  const minimumLines = positiveInteger(options.minimumLines, 3);
  const minimumCharacters = positiveInteger(options.minimumCharacters, 150);
  const summarized =
    options.summarize !== false && meaningful.length > 0 &&
    (lineCount >= minimumLines || normalized.length > minimumCharacters);
  const insertion = summarized
    ? (options.placeholder ?? defaultPlaceholder)({ lineCount, characterCount: normalized.length })
    : normalized;

  return { normalized, insertion, lineCount, summarized };
}

export function insertPastedText(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  pastedText: string,
  options: InsertPasteOptions = {},
): InsertPasteResult {
  const start = clampOffset(text, Math.min(selectionStart, selectionEnd));
  const end = clampOffset(text, Math.max(selectionStart, selectionEnd));
  const prepared = preparePastedText(pastedText, options);
  const next = text.slice(0, start) + prepared.insertion + text.slice(end);
  const cursor = start + prepared.insertion.length;
  if (!prepared.summarized) return { text: next, cursor, normalized: prepared.normalized };

  return {
    text: next,
    cursor,
    normalized: prepared.normalized,
    placeholder: {
      id: options.id ?? `paste:${start}:${hashText(prepared.normalized)}`,
      placeholder: prepared.insertion,
      content: prepared.normalized,
      start,
      end: cursor,
      lineCount: prepared.lineCount,
    },
  };
}

/** Expands only placeholders still present at their tracked ranges. */
export function expandPastePlaceholders(
  text: string,
  placeholders: readonly PastedTextPlaceholder[],
): ExpandedPasteResult {
  const ordered = [...placeholders].sort((a, b) => b.start - a.start || b.end - a.end);
  const unresolved: string[] = [];
  let expanded = text;
  let lastStart = Number.POSITIVE_INFINITY;

  for (const part of ordered) {
    const validRange =
      Number.isInteger(part.start) &&
      Number.isInteger(part.end) &&
      part.start >= 0 &&
      part.end >= part.start &&
      part.end <= expanded.length &&
      part.end <= lastStart;
    if (!validRange || expanded.slice(part.start, part.end) !== part.placeholder) {
      unresolved.push(part.id);
      continue;
    }
    expanded = expanded.slice(0, part.start) + part.content + expanded.slice(part.end);
    lastStart = part.start;
  }

  return { text: expanded, unresolved: unresolved.reverse() };
}

export function restorePastedText(text: string, placeholders: readonly PastedTextPlaceholder[]): string {
  return expandPastePlaceholders(text, placeholders).text;
}

function defaultPlaceholder(input: { lineCount: number }): string {
  const unit = input.lineCount === 1 ? "line" : "lines";
  return `[Pasted ~${input.lineCount} ${unit}]`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function clampOffset(text: string, offset: number): number {
  if (!Number.isFinite(offset)) return text.length;
  return Math.max(0, Math.min(text.length, Math.trunc(offset)));
}

function hashText(text: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}
