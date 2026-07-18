import { readJSONLFile, writeJSONLFile } from "./jsonl.ts";
import type { PromptMode } from "./drafts.ts";

export const DEFAULT_PROMPT_HISTORY_LIMIT = 50;

export interface PromptHistoryEntry<Data = unknown> {
  text: string;
  mode?: PromptMode;
  data?: Data;
}

export interface PromptHistoryOptions {
  limit?: number;
  onPersistenceError?: (error: unknown) => void;
}

export function parsePromptHistory<Data = unknown>(
  text: string,
  limit = DEFAULT_PROMPT_HISTORY_LIMIT,
): PromptHistoryEntry<Data>[] {
  const entries: PromptHistoryEntry<Data>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = normalizePromptHistoryEntry<Data>(JSON.parse(line));
      if (!entry || !entry.text.trim()) continue;
      if (promptHistoryEntriesEqual(entries.at(-1), entry)) continue;
      entries.push(entry);
    } catch {
      // JSONL is intentionally salvageable line by line.
    }
  }
  return entries.slice(-normalizeLimit(limit));
}

export function normalizePromptHistoryEntry<Data = unknown>(value: unknown): PromptHistoryEntry<Data> | undefined {
  if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") return;
  const input = value as { text: string; mode?: unknown; data?: unknown };
  if (input.mode !== undefined && input.mode !== "normal" && input.mode !== "shell") return;
  const entry: PromptHistoryEntry<Data> = {
    text: input.text,
    ...(input.mode ? { mode: input.mode } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "data") ? { data: input.data as Data } : {}),
  };
  return serializableClone(entry);
}

export function promptHistoryEntriesEqual<Data>(
  previous: PromptHistoryEntry<Data> | undefined,
  next: PromptHistoryEntry<Data>,
): boolean {
  if (!previous) return false;
  try {
    return JSON.stringify(previous) === JSON.stringify(next);
  } catch {
    return false;
  }
}

export class PromptHistoryStore<Data = unknown> {
  private readonly filePath: string;
  private readonly limit: number;
  private readonly onPersistenceError?: (error: unknown) => void;
  private readonly listeners = new Set<() => void>();
  private entries: readonly PromptHistoryEntry<Data>[];

  constructor(filePath: string, options: PromptHistoryOptions = {}) {
    this.filePath = filePath;
    this.limit = normalizeLimit(options.limit ?? DEFAULT_PROMPT_HISTORY_LIMIT);
    this.onPersistenceError = options.onPersistenceError;
    this.entries = Object.freeze(parsePromptHistory<Data>(readJSONLFile(filePath), this.limit));
  }

  getSnapshot = (): readonly PromptHistoryEntry<Data>[] => this.entries;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reload(): readonly PromptHistoryEntry<Data>[] {
    this.entries = Object.freeze(parsePromptHistory<Data>(readJSONLFile(this.filePath), this.limit));
    this.emit();
    return this.entries;
  }

  append(value: PromptHistoryEntry<Data>): boolean {
    const entry = normalizePromptHistoryEntry<Data>(value);
    if (!entry || !entry.text.trim() || promptHistoryEntriesEqual(this.entries.at(-1), entry)) return false;
    this.entries = Object.freeze([...this.entries, entry].slice(-this.limit));
    this.persist();
    this.emit();
    return true;
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = Object.freeze([]);
    this.persist();
    this.emit();
  }

  private persist(): void {
    try {
      writeJSONLFile(this.filePath, this.entries);
    } catch (error) {
      this.onPersistenceError?.(error);
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export function createPromptHistoryStore<Data = unknown>(
  filePath: string,
  options: PromptHistoryOptions = {},
): PromptHistoryStore<Data> {
  return new PromptHistoryStore<Data>(filePath, options);
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_PROMPT_HISTORY_LIMIT;
  return Math.max(1, Math.trunc(limit));
}

function serializableClone<T>(value: T): T | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return;
    return JSON.parse(serialized) as T;
  } catch {
    return;
  }
}
