import type { WebContents } from "electron";
import { homedir } from "node:os";
import {
  createSession,
  fetchModels,
  mergeModels,
  type Session,
} from "@cozycode/core";
import type {
  AgentMode,
  ApprovalOutcome,
  ApprovalRequest,
  ProviderConfig,
  SessionConfig,
  SessionEvent,
} from "@cozycode/protocol";
import { IPC, type PermissionPreset, type SessionMeta, type SessionSnapshot } from "../shared/ipc.ts";
import type { SettingsStore } from "./settings.ts";
import { SessionStore } from "./session-store.ts";
import { TerminalManager } from "./terminal-manager.ts";
import { resolvePreset } from "./presets.ts";

/**
 * Owns one live agent session per window plus the on-disk archive of all
 * sessions. Only the active session is live in memory; activating another loads
 * its transcript + history from disk and seeds a fresh core Session so model
 * context carries across app restarts.
 */
export class SessionManager {
  private session: Session | null = null;
  private activeMeta: SessionMeta | null = null;
  /** Provider/workspace signature; a change forces a context-preserving rebuild. */
  private configKey = "";
  private readonly pendingApprovals = new Map<string, (o: ApprovalOutcome) => void>();
  private readonly store = new SessionStore();
  readonly terminals: TerminalManager;
  private modelCache: { at: number; baseURL: string; models: string[] } | null = null;

  constructor(
    private readonly web: WebContents,
    private readonly settings: SettingsStore,
  ) {
    this.terminals = new TerminalManager(web);
  }

  // --- provider config ------------------------------------------------------

  private async provider(): Promise<ProviderConfig> {
    const s = await this.settings.getPublic();
    if (!s) throw new Error("No settings configured yet.");
    if (!s.baseURL) throw new Error("Provider baseURL is required.");
    return {
      name: s.providerName || "openai-compatible",
      baseURL: s.baseURL,
      apiKey: await this.settings.getApiKey(),
    };
  }

  private async buildConfig(meta: SessionMeta): Promise<SessionConfig> {
    const provider = await this.provider();
    const { mode, policy } = resolvePreset(meta.preset);
    return {
      provider,
      model: meta.model,
      workspaceRoot: meta.workspaceRoot ?? homedir(),
      permissions: policy,
      mode,
    };
  }

  /** (Re)build the live session for the active meta, preserving history. */
  private async ensureSession(): Promise<Session> {
    if (!this.activeMeta) throw new Error("No active session.");
    const meta = this.activeMeta;
    const config = await this.buildConfig(meta);
    const key = JSON.stringify({
      provider: config.provider,
      workspaceRoot: config.workspaceRoot,
    });
    if (this.session && key === this.configKey) return this.session;

    // Provider/workspace change: rebuild but carry history forward.
    const initialHistory = this.session
      ? this.session.snapshotHistory()
      : await this.store.readHistory(meta.id);
    this.session?.close();
    this.configKey = key;
    this.session = createSession(config, (req) => this.requestApproval(req), {
      id: meta.id,
      initialHistory,
    });
    this.pump(this.session, meta.id);
    return this.session;
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
    const s = await this.settings.getPublic();
    await this.teardownActive();
    const meta = await this.store.create({
      workspaceRoot: opts.workspaceRoot ?? s?.workspaceRoot ?? null,
      model: s?.model ?? "",
      preset: "ask",
      now: Date.now(),
    });
    this.activeMeta = meta;
    this.session = null;
    this.configKey = "";
    this.terminals.setCwd(meta.workspaceRoot);
    this.notifyChanged();
    return { meta, records: [] };
  }

  async activate(id: string): Promise<SessionSnapshot> {
    const meta = await this.store.get(id);
    if (!meta) throw new Error(`Unknown session: ${id}`);
    await this.teardownActive();
    this.activeMeta = meta;
    this.session = null;
    this.configKey = "";
    this.terminals.setCwd(meta.workspaceRoot);
    const records = await this.store.readRecords(id);
    return { meta, records };
  }

  /**
   * Delete a session. Returns the new active snapshot when the *active* session
   * was removed (so the renderer can swap its transcript), else null.
   */
  async remove(id: string): Promise<SessionSnapshot | null> {
    const wasActive = this.activeMeta?.id === id;
    if (wasActive) {
      await this.teardownActive();
      this.activeMeta = null;
    }
    await this.store.remove(id);
    this.notifyChanged();
    if (!wasActive) return null;
    const next = await this.init();
    this.notifyChanged();
    return next;
  }

  async rename(id: string, title: string): Promise<void> {
    await this.store.rename(id, title);
    if (this.activeMeta?.id === id) this.activeMeta.title = title;
    this.notifyChanged();
  }

  /** Deny parked approvals, flush history, and close the live session. */
  private async teardownActive(): Promise<void> {
    for (const [reqId, resolve] of this.pendingApprovals) {
      resolve("deny");
      this.pendingApprovals.delete(reqId);
    }
    if (this.session && this.activeMeta) {
      await this.store.writeHistory(this.activeMeta.id, this.session.snapshotHistory());
    }
    this.session?.close();
    this.session = null;
  }

  // --- mode / model / preset ------------------------------------------------

  setMode(mode: AgentMode): void {
    this.session?.setMode(mode);
  }

  async setModel(model: string): Promise<void> {
    if (!this.activeMeta) return;
    this.activeMeta.model = model;
    this.session?.setModel(model);
    await this.store.touch(this.activeMeta.id, { model });
    this.notifyChanged();
  }

  async setPreset(preset: PermissionPreset): Promise<void> {
    if (!this.activeMeta) return;
    this.activeMeta.preset = preset;
    const { mode, policy } = resolvePreset(preset);
    if (this.session) {
      this.session.setMode(mode);
      this.session.setPermissions(policy);
    }
    await this.store.touch(this.activeMeta.id, { preset });
    this.notifyChanged();
  }

  // --- model discovery ------------------------------------------------------

  async listModels(): Promise<string[]> {
    const provider = await this.provider().catch(() => null);
    if (!provider) return this.activeMeta?.model ? [this.activeMeta.model] : [];
    const now = Date.now();
    if (
      this.modelCache &&
      this.modelCache.baseURL === provider.baseURL &&
      now - this.modelCache.at < 5 * 60 * 1000
    ) {
      return mergeModels(this.activeMeta?.model ?? "", undefined, this.modelCache.models);
    }
    const fetched = await fetchModels(provider);
    this.modelCache = { at: now, baseURL: provider.baseURL, models: fetched };
    return mergeModels(this.activeMeta?.model ?? "", undefined, fetched);
  }

  // --- streaming + approvals ------------------------------------------------

  private async pump(session: Session, sessionId: string): Promise<void> {
    for await (const event of session.events) {
      this.store.appendEvent(sessionId, event);
      if (this.web.isDestroyed()) return;
      this.web.send(IPC.sessionEvent, event);
    }
  }

  private requestApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(req.requestId, resolve);
      if (!this.web.isDestroyed()) this.web.send(IPC.approvalRequest, req);
    });
  }

  resolveApproval(requestId: string, outcome: ApprovalOutcome): void {
    const resolve = this.pendingApprovals.get(requestId);
    if (resolve) {
      this.pendingApprovals.delete(requestId);
      resolve(outcome);
    }
  }

  async send(message: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.activeMeta) await this.init();
      const meta = this.activeMeta!;
      const session = await this.ensureSession();
      // Persist the user turn + metadata before running the agent. Auto-title
      // updates the index in place; touch then re-persists with the new counts.
      await this.store.maybeAutoTitle(meta.id, message);
      this.store.appendUser(meta.id, message);
      meta.messageCount += 1;
      await this.store.touch(meta.id, {
        messageCount: meta.messageCount,
        updatedAt: Date.now(),
      });
      this.notifyChanged();

      await session.send(message);
      // Snapshot model context after the turn resolves.
      await this.store.writeHistory(meta.id, session.snapshotHistory());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  abort(): void {
    this.session?.abort();
  }

  async dispose(): Promise<void> {
    this.terminals.dispose();
    await this.teardownActive();
    await this.store.dispose();
  }
}
