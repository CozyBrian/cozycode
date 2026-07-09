import type { WebContents } from "electron";
import { homedir } from "node:os";
import {
  createSession,
  mergeRulesets,
  rulesetFromConfig,
  type Session,
} from "@cozycode/core";
import type {
  AgentMode,
  PermissionReplyBody,
  ModelRef,
  SessionConfig,
  SessionEvent,
} from "@cozycode/protocol";
import { IPC, type PermissionPreset, type SessionMeta, type SessionSnapshot } from "../shared/ipc.ts";
import type { SettingsStore } from "./settings.ts";
import type { ProviderBridge } from "./providers.ts";
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
  private readonly store: SessionStore;
  readonly terminals: TerminalManager;

  constructor(
    private readonly web: WebContents,
    private readonly settings: SettingsStore,
    private readonly providers: ProviderBridge,
  ) {
    this.store = new SessionStore(settings.legacyProviderID);
    this.terminals = new TerminalManager(web);
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
    };
  }

  /** (Re)build the live session for the active meta, preserving history. */
  private async ensureSession(): Promise<Session> {
    if (!this.activeMeta) throw new Error("No active session.");
    const meta = this.activeMeta;
    const config = await this.buildConfig(meta);
    const key = JSON.stringify({
      providerID: meta.model.providerID,
      workspaceRoot: config.workspaceRoot,
    });
    if (this.session && key === this.configKey) return this.session;

    // Provider/workspace change: rebuild but carry history forward.
    const initialHistory = this.session
      ? this.session.snapshotHistory()
      : await this.store.readHistory(meta.id);
    // close() cascade-rejects any parked permission asks on the old session.
    this.session?.close();
    this.configKey = key;
    this.session = createSession(config, {
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
    const providerList = await this.providers.list();
    const model = providerList.defaultModel ?? s?.recentModels?.[0] ?? {
      providerID: "openai",
      modelID: "gpt-5.2",
    };
    await this.teardownActive();
    const meta = await this.store.create({
      workspaceRoot: opts.workspaceRoot ?? s?.workspaceRoot ?? null,
      model,
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

  /** Flush history and close the live session (which cascade-rejects parked asks). */
  private async teardownActive(): Promise<void> {
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

  async setModel(model: ModelRef): Promise<void> {
    if (!this.activeMeta) return;
    const providerChanged = model.providerID !== this.activeMeta.model.providerID;
    this.activeMeta.model = model;
    if (providerChanged) this.configKey = "";
    else this.session?.setModel(model.modelID);
    await this.store.touch(this.activeMeta.id, { model });
    this.notifyChanged();
  }

  async setPreset(preset: PermissionPreset): Promise<void> {
    if (!this.activeMeta) return;
    this.activeMeta.preset = preset;
    if (this.session) {
      const config = await this.buildConfig(this.activeMeta);
      if (config.mode) this.session.setMode(config.mode);
      if (config.permissions) this.session.setPermissions(config.permissions);
    }
    await this.store.touch(this.activeMeta.id, { preset });
    this.notifyChanged();
  }

  // --- streaming + approvals ------------------------------------------------

  private async pump(session: Session, sessionId: string): Promise<void> {
    for await (const event of session.events) {
      // Permission asks/replies are live-only control events; persisting them
      // would resurrect stale modals on replay.
      if (event.type !== "permission-asked" && event.type !== "permission-replied") {
        this.store.appendEvent(sessionId, event);
      }
      if (this.web.isDestroyed()) return;
      this.web.send(IPC.sessionEvent, event);
    }
  }

  replyPermission(body: PermissionReplyBody): void {
    this.session?.replyPermission(body.requestId, body.reply, body.message);
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
