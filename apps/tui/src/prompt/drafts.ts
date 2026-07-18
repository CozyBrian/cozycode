export interface RevisionedDraft<T> {
  readonly sessionID: string;
  readonly revision: number;
  readonly value: T;
}

export interface DraftMutation<T> {
  readonly applied: boolean;
  readonly snapshot: RevisionedDraft<T>;
}

export interface SessionDraftStoreOptions<T> {
  initial: T | ((sessionID: string) => T);
  normalize?: (value: T) => T;
}

/**
 * An external store suitable for React's useSyncExternalStore. Supplying an
 * expected revision turns set/update/reset into compare-and-swap operations.
 */
export class SessionDraftStore<T> {
  private readonly initial: (sessionID: string) => T;
  private readonly normalize: (value: T) => T;
  private readonly drafts = new Map<string, RevisionedDraft<T>>();
  private readonly listeners = new Set<() => void>();
  private readonly sessionListeners = new Map<string, Set<() => void>>();

  constructor(options: SessionDraftStoreOptions<T>) {
    this.initial = typeof options.initial === "function" ? (options.initial as (sessionID: string) => T) : () => options.initial as T;
    this.normalize = options.normalize ?? ((value) => value);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeSession(sessionID: string, listener: () => void): () => void {
    const listeners = this.sessionListeners.get(sessionID) ?? new Set<() => void>();
    listeners.add(listener);
    this.sessionListeners.set(sessionID, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.sessionListeners.delete(sessionID);
    };
  }

  get(sessionID: string): RevisionedDraft<T> {
    const current = this.drafts.get(sessionID);
    if (current) return current;
    const created = Object.freeze({
      sessionID,
      revision: 0,
      value: this.normalize(this.initial(sessionID)),
    });
    this.drafts.set(sessionID, created);
    return created;
  }

  snapshot(sessionID: string): () => RevisionedDraft<T> {
    return () => this.get(sessionID);
  }

  set(sessionID: string, value: T, expectedRevision?: number): DraftMutation<T> {
    const current = this.get(sessionID);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      return { applied: false, snapshot: current };
    }
    const snapshot = Object.freeze({
      sessionID,
      revision: current.revision + 1,
      value: this.normalize(value),
    });
    this.drafts.set(sessionID, snapshot);
    this.emit(sessionID);
    return { applied: true, snapshot };
  }

  update(sessionID: string, updater: (value: T) => T, expectedRevision?: number): DraftMutation<T> {
    const current = this.get(sessionID);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      return { applied: false, snapshot: current };
    }
    return this.set(sessionID, updater(current.value), current.revision);
  }

  reset(sessionID: string, expectedRevision?: number): DraftMutation<T> {
    return this.set(sessionID, this.initial(sessionID), expectedRevision);
  }

  sessions(): readonly string[] {
    return [...this.drafts.keys()];
  }

  private emit(sessionID: string): void {
    for (const listener of this.listeners) listener();
    for (const listener of this.sessionListeners.get(sessionID) ?? []) listener();
  }
}

export type PromptMode = "normal" | "shell";

export interface PromptDraft<Data = unknown> {
  text: string;
  cursor: number;
  mode: PromptMode;
  data?: Data;
}

export function createPromptDraftStore<Data = unknown>(
  initial?: Partial<PromptDraft<Data>> | ((sessionID: string) => Partial<PromptDraft<Data>>),
): SessionDraftStore<PromptDraft<Data>> {
  const create = (sessionID: string): PromptDraft<Data> => {
    const value = typeof initial === "function" ? initial(sessionID) : initial;
    return normalizePromptDraft({
      text: value?.text ?? "",
      cursor: value?.cursor ?? 0,
      mode: value?.mode ?? "normal",
      ...(value && "data" in value ? { data: value.data } : {}),
    });
  };
  return new SessionDraftStore({ initial: create, normalize: normalizePromptDraft });
}

export function normalizePromptDraft<Data>(draft: PromptDraft<Data>): PromptDraft<Data> {
  const cursor = Number.isFinite(draft.cursor) ? Math.trunc(draft.cursor) : draft.text.length;
  return {
    ...draft,
    cursor: Math.max(0, Math.min(draft.text.length, cursor)),
    mode: draft.mode === "shell" ? "shell" : "normal",
  };
}
