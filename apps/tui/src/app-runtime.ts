import { dirname, resolve } from "node:path";
import {
  createModel,
  createSession,
  loadAgents,
  registry,
  type SessionOptions,
} from "@cozycode/core";
import type {
  AgentInfo,
  AgentMode,
  ModelRef,
  ProviderList,
  SessionConfig,
} from "@cozycode/protocol";
import {
  BunSQLiteSessionArchive,
  type SessionReplaySnapshot,
  type SessionArchive,
  type SessionMetadata,
  type SessionTurnSummary,
} from "@cozycode/sessions";
import type {
  ComposerDraft,
  ComposerDraftUpdate,
} from "./components/composer/index.ts";
import {
  createPromptHistoryStore,
  type PastedTextPlaceholder,
  type PromptHistoryEntry,
  type PromptMode,
} from "./prompt/index.ts";
import { loadProviders } from "./providers.ts";
import { TuiSessionHost } from "./runtime/index.ts";
import { TuiAppStore } from "./store/index.ts";
import {
  tuiPromptHistoryFile,
  tuiSessionFile,
  tuiSnapshotDirectory,
} from "./state.ts";

const EMPTY_PROVIDERS: ProviderList = { all: [], connected: [] };
const DRAFT_SAVE_DELAY_MS = 250;
export const TUI_RECENT_EVENT_LIMIT = 2_000;
export const TUI_RECENT_TURN_LIMIT = 200;

interface DurableComposerDraftV1 {
  version: 1;
  text: string;
  cursor: number;
  promptMode: PromptMode;
  pastePlaceholders: PastedTextPlaceholder[];
}

interface DraftEntry {
  value: Omit<ComposerDraft, "revision">;
  persistedRevision: number;
  dirty: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface AppPromptHistory {
  getSnapshot(): readonly PromptHistoryEntry<PromptHistoryData>[];
  subscribe(listener: () => void): () => void;
  append(entry: PromptHistoryEntry<PromptHistoryData>): boolean;
}

export interface PromptHistoryData {
  sessionID?: string;
  turnID?: string;
  pastePlaceholders?: PastedTextPlaceholder[];
}

export interface TuiAppRuntimeOptions {
  initialSession: SessionConfig | null;
  initialModel: ModelRef | null;
  workspaceRoot: string;
  sessionOptions?: SessionOptions;
  testEfforts?: string[];
  testProviders?: ProviderList;
  archive?: SessionArchive;
  maxIdleRuntimes?: number;
  deltaCoalesceIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface TuiAppInitialization {
  providers: ProviderList;
  errors: Error[];
}

export interface CreatedTuiAppRuntime {
  runtime: TuiAppRuntime;
  warning?: Error;
}

/** Owns the durable services that must outlive React view transitions. */
export class TuiAppRuntime {
  readonly archive: SessionArchive;
  readonly host: TuiSessionHost;
  readonly store: TuiAppStore;
  readonly drafts: DurableDraftController;
  readonly history: AppPromptHistory;

  private readonly options: TuiAppRuntimeOptions;
  private providers: ProviderList = EMPTY_PROVIDERS;
  private agents: AgentInfo[] = [];
  private titleModels: Awaited<ReturnType<typeof createModel>>[] = [];
  private initializePromise?: Promise<TuiAppInitialization>;
  private closePromise?: Promise<void>;

  constructor(options: TuiAppRuntimeOptions, archive: SessionArchive, persistentHistory: boolean) {
    this.options = options;
    this.archive = archive;
    const metadata = archive.listSessions().filter((session) => sameWorkspace(session.workspace, options.workspaceRoot));
    this.store = new TuiAppStore(metadata);
    this.drafts = new DurableDraftController(archive, this.store, options.onError);
    this.history = persistentHistory
      ? createPromptHistoryStore<PromptHistoryData>(tuiPromptHistoryFile(), {
          onPersistenceError: options.onError,
        })
      : new MemoryPromptHistory();
    this.host = new TuiSessionHost({
      archive,
      snapshotOptions: {
        storageRoot: persistentHistory
          ? tuiSnapshotDirectory()
          : resolve(dirname(options.workspaceRoot), ".cozycode-tui-test-snapshots"),
      },
      maxIdleRuntimes: options.maxIdleRuntimes,
      deltaCoalesceIntervalMs: options.deltaCoalesceIntervalMs,
      runtimeFactory: async ({ metadata: session, initialHistory }) => {
        const config = await this.sessionConfig(session);
        return createSession(config, {
          ...options.sessionOptions,
          agents: options.sessionOptions?.agents ?? this.agents,
          id: session.id,
          initialHistory,
          ...(!options.sessionOptions && this.titleModels.length > 0
            ? { titleModels: this.titleModels }
            : {}),
        });
      },
      onListenerError: options.onError,
    });
    this.host.subscribe((event) => {
      this.store.applyHostEvent(event);
      if (event.type === "session-event" && (event.event.type === "finish" || event.event.type === "error")) {
        const metadata = this.archive.getSession(event.sessionID);
        if (metadata) this.store.upsertMetadata(metadata);
      }
    });
  }

  initialize(): Promise<TuiAppInitialization> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.initializeServices();
    return this.initializePromise;
  }

  setProviders(providers: ProviderList): void {
    this.providers = providers;
  }

  latestWorkspaceSession(): SessionMetadata | undefined {
    return this.host.listSessions().find((session) => sameWorkspace(session.workspace, this.options.workspaceRoot));
  }

  createSession(model: ModelRef, mode: AgentMode, effort?: string): SessionMetadata {
    const metadata = this.host.createSession({
      workspace: this.options.workspaceRoot,
      model,
      mode,
      effort,
    });
    this.store.upsertMetadata(metadata);
    this.replaceFromArchive(metadata.id, true);
    return metadata;
  }

  hydrate(sessionID: string, expectedRevision?: number): boolean {
    const archived = this.host.loadRecentSession(sessionID, {
      eventLimit: TUI_RECENT_EVENT_LIMIT,
      turnLimit: TUI_RECENT_TURN_LIMIT,
    });
    if (!archived) throw new Error(`Unknown session: ${sessionID}`);
    const prepared = this.drafts.prepareArchive(archived);
    return this.store.hydrate(prepared, {
      expectedRevision,
      status: this.host.getLiveStatus(sessionID),
      rollbackCursor: this.archive.getRevertState(sessionID) ?? null,
    });
  }

  replaceFromArchive(sessionID: string, activate = false): void {
    const archived = this.host.loadRecentSession(sessionID, {
      eventLimit: TUI_RECENT_EVENT_LIMIT,
      turnLimit: TUI_RECENT_TURN_LIMIT,
    });
    if (!archived) throw new Error(`Unknown session: ${sessionID}`);
    this.store.replaceSession(this.drafts.prepareArchive(archived), {
      activate,
      status: this.host.getLiveStatus(sessionID),
      rollbackCursor: this.archive.getRevertState(sessionID) ?? null,
    });
  }

  listRecentTurns(sessionID: string): SessionTurnSummary[] {
    return this.host.listRecentVisibleTurns(sessionID, TUI_RECENT_TURN_LIMIT);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.drafts.flushAll();
      await this.host.close();
    })();
    return this.closePromise;
  }

  private async initializeServices(): Promise<TuiAppInitialization> {
    const errors = await this.host.recoverPendingRollbacks();
    if (this.options.testProviders) {
      this.providers = this.options.testProviders;
      this.agents = this.options.sessionOptions?.agents ?? [];
      return { providers: this.providers, errors };
    }
    if (this.options.sessionOptions && this.options.initialSession && this.options.initialModel) {
      const provider = {
        id: this.options.initialModel.providerID,
        name: this.options.initialSession.provider.name,
        source: "custom" as const,
        authMethods: [{ type: "api" as const, label: "Configured API" }],
        models: [...new Set([
          this.options.initialModel.modelID,
          ...(this.options.initialSession.models ?? []),
        ])].map((id) => ({ id, name: id, reasoningEfforts: this.options.testEfforts })),
      };
      this.providers = {
        all: [provider],
        connected: [provider.id],
        defaultModel: this.options.initialModel,
      };
      return { providers: this.providers, errors };
    }

    const [providerResult, agentResult] = await Promise.allSettled([
      loadProviders(),
      loadAgents({ workspaceRoot: this.options.workspaceRoot }),
    ]);
    if (agentResult.status === "fulfilled") this.agents = agentResult.value;
    else errors.push(asError(agentResult.reason));

    let providers = providerResult.status === "fulfilled" ? providerResult.value : EMPTY_PROVIDERS;
    if (providerResult.status === "rejected") errors.push(asError(providerResult.reason));
    providers = withLegacyProvider(providers, this.options.initialSession, this.options.initialModel);
    this.providers = providers;
    this.titleModels = await titleModelsFor(providers);
    return { providers, errors };
  }

  private async sessionConfig(metadata: SessionMetadata): Promise<SessionConfig> {
    let provider: SessionConfig["provider"];
    if (this.options.sessionOptions && this.options.initialSession) {
      provider = this.options.initialSession.provider;
    } else {
      try {
        provider = await registry.providerConfig(metadata.model.providerID);
      } catch (error) {
        const legacy = this.options.initialSession
          && this.options.initialModel?.providerID === metadata.model.providerID;
        if (!legacy) throw error;
        provider = this.options.initialSession!.provider;
      }
    }
    return {
      ...(this.options.initialSession ?? {}),
      provider,
      model: metadata.model.modelID,
      workspaceRoot: metadata.workspace ?? this.options.workspaceRoot,
      permissions: this.options.initialSession?.permissions,
      mode: metadata.mode,
      reasoningEffort: metadata.effort,
    };
  }
}

export class DurableDraftController {
  private readonly entries = new Map<string, DraftEntry>();

  constructor(
    private readonly archive: SessionArchive,
    private readonly store: TuiAppStore,
    private readonly onError?: (error: unknown) => void,
  ) {}

  prepareArchive<T extends SessionReplaySnapshot>(archived: T): T {
    const decoded = decodeDraft(archived.draft?.text);
    const persistedRevision = archived.draft?.revision ?? 0;
    const current = this.entries.get(archived.metadata.id);
    if (!current || (!current.dirty && persistedRevision >= current.persistedRevision)) {
      this.entries.set(archived.metadata.id, {
        value: decoded,
        persistedRevision,
        dirty: false,
      });
    }
    return {
      ...archived,
      draft: archived.draft
        ? { ...archived.draft, text: decoded.text }
        : undefined,
    } as T;
  }

  get(sessionID: string): ComposerDraft {
    const draft = this.store.getState().viewsBySessionID[sessionID]?.draft ?? { text: "", revision: 0 };
    const entry = this.entries.get(sessionID);
    const value = entry?.value ?? emptyComposerDraft(draft.text);
    return {
      ...value,
      text: draft.text,
      revision: draft.revision,
      cursor: Math.min(value.cursor ?? draft.text.length, draft.text.length),
    };
  }

  update(update: ComposerDraftUpdate): boolean {
    return this.replace(
      update.sessionID,
      {
        text: update.text,
        cursor: update.cursor,
        promptMode: update.promptMode,
        pastePlaceholders: clonePlaceholders(update.pastePlaceholders),
      },
      update.expectedRevision,
    );
  }

  replace(
    sessionID: string,
    value: Omit<ComposerDraft, "revision">,
    expectedRevision?: number,
  ): boolean {
    const result = this.store.updateDraft(sessionID, value.text, expectedRevision);
    if (!result.applied) return false;
    const entry = this.ensureEntry(sessionID);
    entry.value = {
      ...value,
      cursor: Math.max(0, Math.min(value.text.length, value.cursor ?? value.text.length)),
      promptMode: value.promptMode === "shell" ? "shell" : "normal",
      pastePlaceholders: clonePlaceholders(value.pastePlaceholders ?? []),
    };
    entry.dirty = true;
    this.schedule(sessionID, entry);
    return true;
  }

  clear(sessionID: string, expectedRevision?: number): boolean {
    return this.replace(sessionID, emptyComposerDraft(""), expectedRevision);
  }

  flush(sessionID: string): void {
    const entry = this.entries.get(sessionID);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!entry.dirty) return;
    try {
      const saved = this.archive.saveDraft({
        sessionID,
        text: encodeDraft(entry.value),
        expectedRevision: entry.persistedRevision,
      });
      entry.persistedRevision = saved.revision;
      entry.dirty = false;
    } catch (error) {
      this.onError?.(error);
    }
  }

  flushAll(): void {
    for (const sessionID of this.entries.keys()) this.flush(sessionID);
  }

  remove(sessionID: string): void {
    const entry = this.entries.get(sessionID);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(sessionID);
  }

  private ensureEntry(sessionID: string): DraftEntry {
    const existing = this.entries.get(sessionID);
    if (existing) return existing;
    const archived = this.archive.getDraft(sessionID);
    const entry = {
      value: decodeDraft(archived?.text),
      persistedRevision: archived?.revision ?? 0,
      dirty: false,
    };
    this.entries.set(sessionID, entry);
    return entry;
  }

  private schedule(sessionID: string, entry: DraftEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.flush(sessionID), DRAFT_SAVE_DELAY_MS);
  }
}

export function createTuiAppRuntime(options: TuiAppRuntimeOptions): CreatedTuiAppRuntime {
  const persistent = !options.archive && !options.sessionOptions;
  let archive = options.archive;
  let warning: Error | undefined;
  if (!archive) {
    try {
      archive = persistent
        ? new BunSQLiteSessionArchive({ filename: tuiSessionFile() })
        : BunSQLiteSessionArchive.inMemory();
    } catch (error) {
      warning = asError(error);
      archive = BunSQLiteSessionArchive.inMemory();
    }
  }

  try {
    return {
      runtime: new TuiAppRuntime(options, archive, persistent && !warning),
      warning,
    };
  } catch (error) {
    try {
      archive.close();
    } catch {}
    const fallback = BunSQLiteSessionArchive.inMemory();
    return {
      runtime: new TuiAppRuntime(options, fallback, false),
      warning: asError(error),
    };
  }
}

function encodeDraft(value: Omit<ComposerDraft, "revision">): string {
  const payload: DurableComposerDraftV1 = {
    version: 1,
    text: value.text,
    cursor: Math.max(0, Math.min(value.text.length, value.cursor ?? value.text.length)),
    promptMode: value.promptMode === "shell" ? "shell" : "normal",
    pastePlaceholders: clonePlaceholders(value.pastePlaceholders ?? []),
  };
  return JSON.stringify(payload);
}

function decodeDraft(value: string | undefined): Omit<ComposerDraft, "revision"> {
  if (!value) return emptyComposerDraft("");
  try {
    const parsed = JSON.parse(value) as Partial<DurableComposerDraftV1>;
    if (parsed.version !== 1 || typeof parsed.text !== "string") return emptyComposerDraft(value);
    return {
      text: parsed.text,
      cursor: typeof parsed.cursor === "number" ? parsed.cursor : parsed.text.length,
      promptMode: parsed.promptMode === "shell" ? "shell" : "normal",
      pastePlaceholders: Array.isArray(parsed.pastePlaceholders)
        ? parsed.pastePlaceholders.filter(isPastePlaceholder).map((placeholder) => ({ ...placeholder }))
        : [],
    };
  } catch {
    return emptyComposerDraft(value);
  }
}

function emptyComposerDraft(text: string): Omit<ComposerDraft, "revision"> {
  return { text, cursor: text.length, promptMode: "normal", pastePlaceholders: [] };
}

function isPastePlaceholder(value: unknown): value is PastedTextPlaceholder {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PastedTextPlaceholder>;
  return typeof item.id === "string"
    && typeof item.placeholder === "string"
    && typeof item.content === "string"
    && Number.isInteger(item.start)
    && Number.isInteger(item.end)
    && Number.isInteger(item.lineCount);
}

function clonePlaceholders(placeholders: readonly PastedTextPlaceholder[]): PastedTextPlaceholder[] {
  return placeholders.map((placeholder) => ({ ...placeholder }));
}

class MemoryPromptHistory implements AppPromptHistory {
  private readonly listeners = new Set<() => void>();
  private entries: readonly PromptHistoryEntry<PromptHistoryData>[] = [];

  getSnapshot = (): readonly PromptHistoryEntry<PromptHistoryData>[] => this.entries;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  append(entry: PromptHistoryEntry<PromptHistoryData>): boolean {
    if (!entry.text.trim()) return false;
    this.entries = [...this.entries, structuredClone(entry)].slice(-50);
    for (const listener of this.listeners) listener();
    return true;
  }
}

async function titleModelsFor(providers: ProviderList) {
  const candidates = providers.all.flatMap((provider) => providers.connected.includes(provider.id)
    ? provider.models
      .filter((model) => model.id.toLowerCase() === "deepseek-v4-flash")
      .map((model) => ({ providerID: provider.id, modelID: model.id }))
    : []);
  const models = await Promise.all(candidates.map(async ({ providerID, modelID }) => {
    try {
      return createModel(await registry.providerConfig(providerID), modelID);
    } catch {
      return undefined;
    }
  }));
  return models.filter((model): model is NonNullable<typeof model> => model !== undefined);
}

function withLegacyProvider(
  providers: ProviderList,
  session: SessionConfig | null,
  model: ModelRef | null,
): ProviderList {
  if (!session || !model || providers.all.some((provider) => provider.id === model.providerID)) return providers;
  const provider = {
    id: model.providerID,
    name: session.provider.name,
    source: "custom" as const,
    authMethods: [{ type: "api" as const, label: "Configured API" }],
    models: [...new Set([model.modelID, ...(session.models ?? [])])].map((id) => ({ id, name: id })),
  };
  return {
    ...providers,
    all: [provider, ...providers.all],
    connected: [provider.id, ...providers.connected],
    defaultModel: providers.defaultModel ?? model,
  };
}

function sameWorkspace(workspace: string | null, current: string): boolean {
  return workspace !== null && resolve(workspace) === resolve(current);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
