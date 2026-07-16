import { app, type WebContents } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatTranscriptMarkdown, type MarkdownTranscriptItem } from "@cozycode/commands";
import {
  createSession,
  createModel,
  loadAgents,
  mergeRulesets,
  rulesetFromConfig,
  type Session,
} from "@cozycode/core";
import type {
  AgentMode,
  ModelRef,
  SessionConfig,
  SessionEvent,
} from "@cozycode/protocol";
import {
  IPC,
  type AddressedPermissionReply,
  type AddressedQuestionReply,
  type PermissionPreset,
  type SessionMeta,
  type SessionRecord,
  type SessionSnapshot,
} from "../shared/ipc.ts";
import type { SettingsStore } from "./settings.ts";
import type { ProviderBridge } from "./providers.ts";
import { SessionStore } from "./session-store.ts";
import { TerminalManager } from "./terminal-manager.ts";
import { GitManager } from "./git-manager.ts";
import { resolvePreset } from "./presets.ts";

interface SessionRuntime {
  session: Session;
  meta: SessionMeta;
  records: SessionRecord[];
  running: boolean;
  stale: boolean;
  lastUsed: number;
  mutation: Promise<void>;
  send: Promise<{ ok: boolean; error?: string }> | null;
  pump: Promise<void>;
}

/** Owns independently running core sessions plus their on-disk archive. */
export class SessionManager {
  private static readonly MAX_IDLE_RUNTIMES = 4;
  private activeId: string | null = null;
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly runtimePromises = new Map<string, Promise<SessionRuntime>>();
  private readonly closingRuntimes = new Map<string, Promise<void>>();
  private readonly pendingSends = new Set<string>();
  private readonly abortRequested = new Set<string>();
  private activationSequence = 0;
  private disposePromise: Promise<void> | null = null;
  private closing = false;
  private readonly store: SessionStore;
  readonly terminals: TerminalManager;
  readonly git: GitManager;

  constructor(
    private readonly web: WebContents,
    private readonly settings: SettingsStore,
    private readonly providers: ProviderBridge,
  ) {
    this.store = new SessionStore(join(app.getPath("userData"), "sessions"), settings.legacyProviderID);
    this.terminals = new TerminalManager(web);
    this.git = new GitManager(web);
  }

  // --- provider config ------------------------------------------------------

  private async buildConfig(meta: SessionMeta): Promise<SessionConfig> {
    const provider = await this.providers.providerConfig(meta.model.providerID);
    const settings = await this.settings.getPublic();
    const { mode, ruleset } = resolvePreset(meta.preset);
    // User config overrides are merged last so they win (last-match-wins).
    const permissions = settings?.permissions
      ? mergeRulesets(ruleset, rulesetFromConfig(settings.permissions))
      : ruleset;
    return {
      provider,
      model: meta.model.modelID,
      workspaceRoot: meta.workspaceRoot ?? homedir(),
      permissions,
      mode,
      reasoningEffort: settings?.reasoningEfforts?.[`${meta.model.providerID}/${meta.model.modelID}`],
    };
  }

  /** Build one live runtime without disturbing any other session. */
  private async createRuntime(meta: SessionMeta): Promise<SessionRuntime> {
    const config = await this.buildConfig(meta);
    const [initialHistory, records] = await Promise.all([
      this.store.readHistory(meta.id),
      this.store.readRecords(meta.id),
    ]);
    const agents = await loadAgents({ workspaceRoot: config.workspaceRoot }).catch(() => []);
    const providers = await this.providers.list();
    const titleModels = (await Promise.all(
      providers.all
        .flatMap((provider) => providers.connected.includes(provider.id)
          ? provider.models
            .filter((model) => model.id.toLowerCase() === "deepseek-v4-flash")
            .map((model) => ({ providerID: provider.id, modelID: model.id }))
          : [])
        .map(async ({ providerID, modelID }) => {
          try {
            return createModel(await this.providers.providerConfig(providerID), modelID);
          } catch {
            return undefined;
          }
        }),
    )).flatMap((model) => model ? [model] : []);
    const session = createSession(config, {
      id: meta.id,
      initialHistory,
      agents,
      titleModels,
    });
    const runtime = {
      session,
      meta,
      records,
      running: false,
      stale: false,
      lastUsed: Date.now(),
      mutation: Promise.resolve(),
      send: null,
      pump: Promise.resolve(),
    } satisfies SessionRuntime;
    this.runtimes.set(meta.id, runtime);
    runtime.pump = this.pump(runtime).catch((error) => {
      console.error("Session event pump failed", error);
    });
    return runtime;
  }

  private async ensureRuntime(id: string): Promise<SessionRuntime> {
    await this.closingRuntimes.get(id);
    const current = this.runtimes.get(id);
    if (current && !current.stale) return current;
    if (current?.running) return current;
    if (current) await this.closeRuntime(id, current, false);

    const pending = this.runtimePromises.get(id);
    if (pending) return pending;
    const creation = this.store.get(id).then((meta) => {
      if (!meta) throw new Error(`Unknown session: ${id}`);
      return this.createRuntime(meta);
    });
    this.runtimePromises.set(id, creation);
    try {
      return await creation;
    } finally {
      this.runtimePromises.delete(id);
    }
  }

  private snapshot(meta: SessionMeta, records: SessionRecord[], runtime?: SessionRuntime): SessionSnapshot {
    return {
      meta,
      records,
      running: Boolean(runtime?.running || this.pendingSends.has(meta.id)),
      permissionQueue: runtime?.session.pendingPermissions() ?? [],
      questionQueue: runtime?.session.pendingQuestions() ?? [],
    };
  }

  // --- session lifecycle ----------------------------------------------------

  async list(): Promise<SessionMeta[]> {
    return this.store.list();
  }

  private notifyChanged(): void {
    void this.store.list().then((sessions) => {
      if (!this.web.isDestroyed()) this.web.send(IPC.sessionsChanged, sessions);
    });
  }

  /** Activate the most-recent session, creating one if the archive is empty. */
  async init(): Promise<SessionSnapshot> {
    const list = await this.store.list();
    if (list[0]) return this.activate(list[0].id);
    return this.create({});
  }

  async create(opts: { workspaceRoot?: string | null }): Promise<SessionSnapshot> {
    const activation = ++this.activationSequence;
    const s = await this.settings.getPublic();
    const providerList = await this.providers.list();
    const model = providerList.defaultModel ?? s?.recentModels?.[0] ?? {
      providerID: "openai",
      modelID: "gpt-5.2",
    };
    const meta = await this.store.create({
      workspaceRoot: opts.workspaceRoot ?? s?.workspaceRoot ?? null,
      model,
      preset: "ask",
      now: Date.now(),
    });
    if (activation === this.activationSequence) {
      this.activeId = meta.id;
      this.terminals.setCwd(meta.workspaceRoot);
      this.git.setCwd(meta.workspaceRoot);
    }
    this.notifyChanged();
    return this.snapshot(meta, []);
  }

  async activate(id: string): Promise<SessionSnapshot> {
    const activation = ++this.activationSequence;
    const meta = await this.store.get(id);
    if (!meta) throw new Error(`Unknown session: ${id}`);
    if (activation === this.activationSequence) {
      this.activeId = meta.id;
      this.terminals.setCwd(meta.workspaceRoot);
      this.git.setCwd(meta.workspaceRoot);
    }
    await this.closingRuntimes.get(id);
    const runtime = this.runtimes.get(id) ?? await this.runtimePromises.get(id);
    if (runtime) runtime.lastUsed = Date.now();
    const records = runtime?.records ?? await this.store.readRecords(id);
    return this.snapshot(runtime?.meta ?? meta, records, runtime);
  }

  /**
   * Delete a session. Returns the new active snapshot when the *active* session
   * was removed (so the renderer can swap its transcript), else null.
   */
  async remove(id: string): Promise<SessionSnapshot | null> {
    ++this.activationSequence;
    const wasActive = this.activeId === id;
    const runtime = this.runtimes.get(id) ?? await this.runtimePromises.get(id);
    if (runtime) await this.closeRuntime(id, runtime, true);
    if (wasActive) this.activeId = null;
    await this.store.remove(id);
    this.notifyChanged();
    if (!wasActive) return null;
    const next = await this.init();
    this.notifyChanged();
    return next;
  }

  async rename(id: string, title: string): Promise<void> {
    await this.store.rename(id, title);
    const runtime = this.runtimes.get(id);
    if (runtime) {
      runtime.meta.title = title;
      runtime.meta.titleEdited = true;
    }
    this.notifyChanged();
  }

  async exportMarkdown(id: string): Promise<{ title: string; markdown: string }> {
    const meta = await this.store.get(id);
    if (!meta) throw new Error(`Unknown session: ${id}`);
    const runtime = this.runtimes.get(id) ?? await this.runtimePromises.get(id);
    const records = runtime?.records ?? await this.store.readRecords(id);
    return { title: meta.title, markdown: formatTranscriptMarkdown(meta.title, markdownItems(records)) };
  }

  // --- mode / model / preset ------------------------------------------------

  setMode(id: string, mode: AgentMode): void {
    this.runtimes.get(id)?.session.setMode(mode);
  }

  /**
   * Set the live session's reasoning effort. The renderer persists the choice
   * to settings and drives this after a model switch, so main stays dumb about
   * which levels a model supports.
   */
  setReasoningEffort(id: string, effort: string | undefined): void {
    this.runtimes.get(id)?.session.setReasoningEffort(effort);
  }

  async setModel(id: string, model: ModelRef): Promise<void> {
    const existing = this.runtimes.get(id);
    const existingProvider = existing?.meta.model.providerID;
    const meta = existing?.meta ?? await this.store.get(id);
    if (!meta) return;
    meta.model = model;
    await this.store.touch(id, { model });
    const runtime = existing ?? this.runtimes.get(id) ?? await this.runtimePromises.get(id);
    if (runtime) {
      const providerChanged = model.providerID !== (existingProvider ?? runtime.meta.model.providerID);
      runtime.meta.model = model;
      if (providerChanged || runtime.running) runtime.stale = true;
      else runtime.session.setModel(model.modelID);
    }
    this.notifyChanged();
  }

  async setPreset(id: string, preset: PermissionPreset): Promise<void> {
    const existing = this.runtimes.get(id);
    const meta = existing?.meta ?? await this.store.get(id);
    if (!meta) return;
    meta.preset = preset;
    await this.store.touch(id, { preset });
    const runtime = existing ?? this.runtimes.get(id) ?? await this.runtimePromises.get(id);
    if (runtime) {
      runtime.meta.preset = preset;
      const mutation = runtime.mutation.then(async () => {
        const config = await this.buildConfig(runtime.meta);
        if (config.mode) runtime.session.setMode(config.mode);
        if (config.permissions) runtime.session.setPermissions(config.permissions);
      });
      runtime.mutation = mutation.catch(() => undefined);
      await mutation;
    }
    this.notifyChanged();
  }

  // --- streaming + approvals ------------------------------------------------

  private async pump(runtime: SessionRuntime): Promise<void> {
    const { session, meta } = runtime;
    for await (const event of session.events) {
      // Subagents run in the background of the parent turn; their wrapped events
      // are persisted to the PARENT log so replay reconstructs the nested block,
      // and the renderer folds them into a read-only drill-in view. They are not
      // top-level runtime entries and share their parent's lifecycle.
      // Permission/question asks are live-only control events; persisting them
      // would resurrect stale modals on replay.
      const liveOnly =
        event.type === "title-change" ||
        event.type === "permission-asked" ||
        event.type === "permission-replied" ||
        event.type === "question-asked" ||
        event.type === "question-answered" ||
        event.type === "question-rejected";
      if (!liveOnly) {
        try {
          this.store.appendEvent(meta.id, event);
          runtime.records.push({ at: Date.now(), kind: "event", event });
        } catch {
          // A persistence hiccup must never break event forwarding to the UI.
        }
      }
      if (event.type === "title-change") {
        if (await this.store.applyGeneratedTitle(meta.id, event.title)) {
          runtime.meta.title = event.title;
          this.notifyChanged();
        }
        continue;
      }
      if (this.web.isDestroyed()) return;
      this.web.send(IPC.sessionEvent, { sessionId: meta.id, event });
    }
  }

  replyPermission(body: AddressedPermissionReply): void {
    this.runtimes.get(body.sessionId)?.session.replyPermission(body.requestId, body.reply, body.message);
  }

  replyQuestion(body: AddressedQuestionReply): void {
    const session = this.runtimes.get(body.sessionId)?.session;
    if (body.answers === null) session?.rejectQuestion(body.requestId);
    else session?.answerQuestion(body.requestId, body.answers);
  }

  send(id: string, message: string): Promise<{ ok: boolean; error?: string }> {
    if (this.closing) return Promise.resolve({ ok: false, error: "The window is closing." });
    if (this.pendingSends.has(id) || this.runtimes.get(id)?.running) {
      return Promise.resolve({ ok: false, error: "This session is already running." });
    }
    this.pendingSends.add(id);
    const operation = this.sendInternal(id, message);
    void operation.finally(() => {
      this.pendingSends.delete(id);
      this.abortRequested.delete(id);
    });
    return operation;
  }

  private async sendInternal(id: string, message: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const runtime = await this.ensureRuntime(id);
      if (runtime.running) return { ok: false, error: "This session is already running." };
      if (this.closing) return { ok: false, error: "The window is closing." };
      await runtime.mutation;
      runtime.running = true;
      runtime.lastUsed = Date.now();
      const operation = (async () => {
        // Persist the user turn + metadata before running the agent.
        const now = Date.now();
        runtime.meta.messageCount = this.store.appendUserTurn(id, message, now);
        runtime.records.push({ at: now, kind: "user", text: message });
        runtime.meta.updatedAt = now;
        this.notifyChanged();
        if (this.closing) return { ok: false, error: "The window is closing." };
        if (this.abortRequested.delete(id)) {
          const event = { type: "finish", reason: "abort" } satisfies SessionEvent;
          this.store.appendEvent(id, event);
          runtime.records.push({ at: Date.now(), kind: "event", event });
          if (!this.web.isDestroyed()) this.web.send(IPC.sessionEvent, { sessionId: id, event });
          return { ok: true };
        }
        await runtime.session.send(message);
        await this.store.writeHistory(id, runtime.session.snapshotHistory());
        return { ok: true };
      })().catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      runtime.send = operation;
      try {
        return await operation;
      } finally {
        runtime.running = false;
        if (runtime.send === operation) runtime.send = null;
        void this.evictIdleRuntimes();
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  abort(id: string): void {
    if (!this.pendingSends.has(id)) return;
    this.abortRequested.add(id);
    this.runtimes.get(id)?.session.abort();
  }

  private closeRuntime(id: string, runtime: SessionRuntime, abort: boolean): Promise<void> {
    const pending = this.closingRuntimes.get(id);
    if (pending) {
      if (!abort) return pending;
      return pending.then(() =>
        this.runtimes.get(id) === runtime
          ? this.closeRuntime(id, runtime, true)
          : undefined,
      );
    }
    const close = (async () => {
      if (abort) runtime.session.abort();
      await runtime.send?.catch(() => undefined);
      // Idle-cache eviction must not close a session selected while this task queued.
      if (!abort && !runtime.stale && this.activeId === id) return;
      await runtime.mutation;
      await this.store.writeHistory(id, runtime.session.snapshotHistory());
      runtime.session.close();
      await runtime.pump;
      if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
    })();
    this.closingRuntimes.set(id, close);
    void close
      .finally(() => {
        if (this.closingRuntimes.get(id) === close) this.closingRuntimes.delete(id);
      })
      .catch(() => undefined);
    return close;
  }

  private async evictIdleRuntimes(): Promise<void> {
    const idle = [...this.runtimes.entries()]
      .filter(([id, runtime]) => id !== this.activeId && !runtime.running)
      .sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    const excess = Math.max(0, this.runtimes.size - SessionManager.MAX_IDLE_RUNTIMES);
    await Promise.allSettled(
      idle.slice(0, excess).map(([id, runtime]) => this.closeRuntime(id, runtime, false)),
    );
  }

  private async disposeInternal(): Promise<void> {
    this.terminals.dispose();
    this.git.dispose();
    await Promise.allSettled(this.runtimePromises.values());
    await Promise.allSettled(
      [...this.runtimes].map(([id, runtime]) => this.closeRuntime(id, runtime, true)),
    );
    await this.store.dispose();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.closing = true;
    return (this.disposePromise = this.disposeInternal());
  }
}

function markdownItems(records: SessionRecord[]): MarkdownTranscriptItem[] {
  const items: MarkdownTranscriptItem[] = [];
  for (const record of records) {
    if (record.kind === "user") {
      items.push({ kind: "user", text: record.text });
      continue;
    }
    const event = record.event;
    if (event.type === "text-delta") {
      const last = items.at(-1);
      if (last?.kind === "assistant") last.text = `${last.text ?? ""}${event.text}`;
      else items.push({ kind: "assistant", text: event.text });
    } else if (event.type === "reasoning-delta") {
      const last = items.at(-1);
      if (last?.kind === "reasoning") last.text = `${last.text ?? ""}${event.text}`;
    } else if (event.type === "reasoning-start") {
      items.push({ kind: "reasoning", text: "" });
    } else if (event.type === "tool-call-start") {
      items.push({ kind: "tool", toolName: event.toolName, args: event.args, status: "running" });
    } else if (event.type === "tool-result") {
      const tool = [...items].reverse().find((item) => item.kind === "tool" && item.status === "running");
      if (tool) Object.assign(tool, { result: event.result, status: event.isError ? "error" : "done" });
    } else if (event.type === "error") {
      items.push({ kind: "error", text: event.message });
    }
  }
  return items;
}
