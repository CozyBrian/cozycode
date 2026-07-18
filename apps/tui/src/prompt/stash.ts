import { randomUUID } from "node:crypto";
import { readJSONLFile, writeJSONLFile } from "./jsonl.ts";
import { normalizePromptHistoryEntry, type PromptHistoryEntry } from "./history.ts";

export const DEFAULT_PROMPT_STASH_LIMIT = 50;

export interface PromptStashEntry<Data = unknown> extends PromptHistoryEntry<Data> {
  id: string;
  createdAt: number;
}

export interface PromptStashOptions {
  limit?: number;
  now?: () => number;
  createID?: () => string;
  onPersistenceError?: (error: unknown) => void;
}

export function parsePromptStash<Data = unknown>(text: string, limit = DEFAULT_PROMPT_STASH_LIMIT): PromptStashEntry<Data>[] {
  const entries: PromptStashEntry<Data>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const prompt = normalizePromptHistoryEntry<Data>(value);
      if (!prompt || !prompt.text.trim() || typeof value.id !== "string" || !value.id) continue;
      if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) continue;
      entries.push({ ...prompt, id: value.id, createdAt: value.createdAt });
    } catch {
      // Keep valid entries around an interrupted or manually edited line.
    }
  }
  return entries.slice(-normalizeLimit(limit));
}

export class PromptStashStore<Data = unknown> {
  private readonly filePath: string;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly createID: () => string;
  private readonly onPersistenceError?: (error: unknown) => void;
  private readonly listeners = new Set<() => void>();
  private entries: readonly PromptStashEntry<Data>[];

  constructor(filePath: string, options: PromptStashOptions = {}) {
    this.filePath = filePath;
    this.limit = normalizeLimit(options.limit ?? DEFAULT_PROMPT_STASH_LIMIT);
    this.now = options.now ?? Date.now;
    this.createID = options.createID ?? randomUUID;
    this.onPersistenceError = options.onPersistenceError;
    this.entries = Object.freeze(parsePromptStash<Data>(readJSONLFile(filePath), this.limit));
  }

  getSnapshot = (): readonly PromptStashEntry<Data>[] => this.entries;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  reload(): readonly PromptStashEntry<Data>[] {
    this.entries = Object.freeze(parsePromptStash<Data>(readJSONLFile(this.filePath), this.limit));
    this.emit();
    return this.entries;
  }

  push(value: PromptHistoryEntry<Data>): PromptStashEntry<Data> | undefined {
    const prompt = normalizePromptHistoryEntry<Data>(value);
    if (!prompt || !prompt.text.trim()) return;
    const entry = { ...prompt, id: this.createID(), createdAt: this.now() };
    if (!entry.id || !Number.isFinite(entry.createdAt)) return;
    this.entries = Object.freeze([...this.entries, entry].slice(-this.limit));
    this.persist();
    this.emit();
    return entry;
  }

  pop(): PromptStashEntry<Data> | undefined {
    const entry = this.entries.at(-1);
    if (!entry) return;
    this.entries = Object.freeze(this.entries.slice(0, -1));
    this.persist();
    this.emit();
    return entry;
  }

  remove(id: string): PromptStashEntry<Data> | undefined {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const entry = this.entries[index];
    this.entries = Object.freeze([...this.entries.slice(0, index), ...this.entries.slice(index + 1)]);
    this.persist();
    this.emit();
    return entry;
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

export function createPromptStashStore<Data = unknown>(
  filePath: string,
  options: PromptStashOptions = {},
): PromptStashStore<Data> {
  return new PromptStashStore<Data>(filePath, options);
}

function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_PROMPT_STASH_LIMIT;
  return Math.max(1, Math.trunc(limit));
}
