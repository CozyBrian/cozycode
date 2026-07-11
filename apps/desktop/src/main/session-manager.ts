import type { WebContents } from "electron";
import { homedir } from "node:os";
import { formatTranscriptMarkdown, type MarkdownTranscriptItem } from "@cozycode/commands";
import {
  createSession,
  createModel,
  generateModelText,
  loadAgents,
  mergeRulesets,
  rulesetFromConfig,
  type Session,
} from "@cozycode/core";
import type {
  AgentMode,
  PermissionReplyBody,
  QuestionReplyBody,
  ModelRef,
  ProviderList,
  SessionConfig,
  SessionEvent,
} from "@cozycode/protocol";
import {
  IPC,
  type GitCommitDraft,
  type GitPullRequestDraft,
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
import { splitCommitDraft } from "./git-drafts.ts";
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
  readonly git: GitManager;

  constructor(
    private readonly web: WebContents,
    private readonly settings: SettingsStore,
    private readonly providers: ProviderBridge,
  ) {
    this.store = new SessionStore(settings.legacyProviderID);
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

  /** (Re)build the live session for the active meta, preserving history. */
  private async ensureSession(): Promise<Session> {
    if (!this.activeMeta) throw new Error("No active session.");
    const meta = this.activeMeta;
    const config = await this.buildConfig(meta);
    const key = JSON.stringify({
      providerID: meta.model.providerID,
      provider: config.provider,
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
    this.session = createSession(config, {
      id: meta.id,
      initialHistory,
      agents,
      titleModels,
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
    this.git.setCwd(meta.workspaceRoot);
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
    this.git.setCwd(meta.workspaceRoot);
    const records = await this.store.readRecords(id);
    return { meta, records };
  }

  async generateCommitDraft(): Promise<GitCommitDraft> {
    await this.git.stageAll();
    const context = await this.git.commitContext();
    const text = await this.generateGitText("commit", [
      "Generate a Conventional Commit message from the staged git changes below.",
      "Output ONLY the commit message with no extra commentary.",
      "Format:",
      "- First line: conventional commit subject (e.g., feat:, fix:, chore:, docs:, refactor:, test:)",
      "- Blank line",
      "- 2 to 5 bullet points describing the changes",
      "Avoid quoting diffs verbatim unless needed for clarity.",
      "",
      "git status:", context.status || "(no output)",
      "",
      "git diff --cached --stat:", context.stat || "(no changes)",
      "",
      "git diff --cached:", context.diff || "(no changes)",
    ].join("\n"));
    const { subject, body } = splitCommitDraft(text);
    if (!subject) throw new Error("The generated commit message did not contain a subject.");
    return { subject, body, index: context.index };
  }

  async commitGitDraft(draft: GitCommitDraft): Promise<void> {
    await this.git.commit(draft.subject, draft.body, draft.index);
  }

  pullRequestBases(): Promise<string[]> {
    return this.git.pullRequestBases();
  }

  async generatePullRequestDraft(base: string): Promise<GitPullRequestDraft> {
    const context = await this.git.pullRequestContext(base);
    const text = await this.generateGitText("pullRequest", [
      "Generate a PR description from the following git outputs.",
      "Return markdown formatted text suitable for a pull request description.",
      "Avoid quoting diffs verbatim unless needed for clarity.",
      "",
      "git status:", context.status || "(no output)",
      "",
      `git log --oneline ${context.base}..HEAD:`, context.log || "(no commits)",
      "",
      `git diff ${context.base}..HEAD --stat:`, context.stat || "(no changes)",
      "",
      `git diff ${context.base}..HEAD:`, context.diff || "(no changes)",
    ].join("\n"));
    if (!text.trim()) throw new Error("The generated PR description was empty.");
    return { markdown: text.trim(), base: context.base };
  }

  private async generateGitText(flow: "commit" | "pullRequest", prompt: string): Promise<string> {
    if (!this.activeMeta) throw new Error("No active session.");
    const settings = await this.settings.getPublic();
    const preferred = flow === "commit" ? settings?.gitCommitModel : settings?.gitPullRequestModel;
    const list = await this.providers.list();
    const modelRef = usableModel(preferred, list) ? preferred : this.activeMeta.model;
    if (!usableModel(modelRef, list)) throw new Error("The active model is unavailable. Connect a provider in Settings.");
    const model = createModel(await this.providers.providerConfig(modelRef.providerID), modelRef.modelID);
    return generateModelText(model, prompt);
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

  async exportMarkdown(id: string): Promise<{ title: string; markdown: string }> {
    const meta = await this.store.get(id);
    if (!meta) throw new Error(`Unknown session: ${id}`);
    return { title: meta.title, markdown: formatTranscriptMarkdown(meta.title, markdownItems(await this.store.readRecords(id))) };
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

  /**
   * Set the live session's reasoning effort. The renderer persists the choice
   * to settings and drives this after a model switch, so main stays dumb about
   * which levels a model supports.
   */
  setReasoningEffort(effort: string | undefined): void {
    this.session?.setReasoningEffort(effort);
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
      // Subagents run in the background of the parent turn; their wrapped events
      // are persisted to the PARENT log so replay reconstructs the nested block,
      // and the renderer folds them into a read-only drill-in view. (No separate
      // child session — activating one would tear the live parent session down.)
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
          this.store.appendEvent(sessionId, event);
        } catch {
          // A persistence hiccup must never break event forwarding to the UI.
        }
      }
      if (event.type === "title-change") {
        if (await this.store.applyGeneratedTitle(sessionId, event.title)) {
          if (this.activeMeta?.id === sessionId) this.activeMeta.title = event.title;
          this.notifyChanged();
        }
        continue;
      }
      if (this.web.isDestroyed()) return;
      this.web.send(IPC.sessionEvent, event);
    }
  }

  replyPermission(body: PermissionReplyBody): void {
    this.session?.replyPermission(body.requestId, body.reply, body.message);
  }

  replyQuestion(body: QuestionReplyBody): void {
    if (body.answers === null) this.session?.rejectQuestion(body.requestId);
    else this.session?.answerQuestion(body.requestId, body.answers);
  }

  async send(message: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (!this.activeMeta) await this.init();
      const meta = this.activeMeta!;
      const session = await this.ensureSession();
      // Persist the user turn + metadata before running the agent.
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
    this.git.dispose();
    await this.teardownActive();
    await this.store.dispose();
  }
}

function usableModel(model: ModelRef | undefined, providers: ProviderList): model is ModelRef {
  if (!model || !providers.connected.includes(model.providerID)) return false;
  return Boolean(providers.all.find((provider) => provider.id === model.providerID)?.models.some((item) => item.id === model.modelID));
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
