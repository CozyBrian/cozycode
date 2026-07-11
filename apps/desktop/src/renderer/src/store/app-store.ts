import { create } from "zustand";
import type {
  AgentMode,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  ProviderList,
  QuestionRequest,
  SessionEvent,
  TokenUsage,
} from "@cozycode/protocol";
import type {
  AppSettings,
  GitStatus,
  PermissionPreset,
  SessionMeta,
  SessionRecord,
} from "../../../shared/ipc.ts";

export type ContentPanelTab = "overview" | "diffs" | "git";

/** A file diff pinned into the Diffs pane (from a chat card or the Git pane). */
export interface SelectedDiff {
  path: string;
  patch: string;
  source: "chat" | "git";
}

/** Running token totals for the active session. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
import { effortsForModel, modelKey, resolveEffort } from "@cozycode/commands";
import { foldEvent, userItem, type TranscriptItem } from "../transcript.ts";
import { emptySessionForWorkspace, workspaceRoots } from "../../../shared/workspaces.ts";

interface TermTab {
  id: string; // pty id from main
  title: string;
}

export interface AppState {
  // bootstrap
  settings: AppSettings | null;
  loaded: boolean;

  // ui
  sidebarOpen: boolean;
  sidebarWidth: number;
  terminalOpen: boolean;
  terminalHeight: number;
  contentPanelOpen: boolean;
  contentPanelWidth: number;
  contentPanelTab: ContentPanelTab;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  helpOpen: boolean;
  modelPickerOpen: boolean;
  effortPickerOpen: boolean;

  // sessions
  sessions: SessionMeta[];
  activeId: string | null;
  /** When set, the transcript shows a read-only view of this subagent (by child session id). */
  subagentView: string | null;
  /** Drill-in routes for the active session; `null` represents its parent transcript. */
  subagentHistory: Array<string | null>;
  subagentHistoryIndex: number;
  /** Activated top-level sessions, used by the title-bar back and forward controls. */
  sessionHistory: string[];
  sessionHistoryIndex: number;

  // active chat
  items: TranscriptItem[];
  busy: boolean;
  /** Usage from the most recent finished turn (for the context meter). */
  turnUsage: TokenUsage | null;
  /** Accumulated usage across the active session's turns. */
  sessionUsage: SessionUsage;
  preset: PermissionPreset;
  model: ModelRef | null;
  /** Reasoning effort for the current model (undefined = provider default). */
  effort: string | undefined;
  providers: ProviderList | null;
  recentModels: ModelRef[];
  /** FIFO of pending permission asks; the modal shows the head, badge shows length. */
  permissionQueue: PermissionRequest[];
  /** FIFO of pending `ask_user` questions; the modal shows the head. */
  questionQueue: QuestionRequest[];
  input: string;

  // terminals
  termTabs: TermTab[];
  activeTermId: string | null;

  // content panel
  /** File pinned into the Diffs pane; null → empty pane. */
  selectedDiff: SelectedDiff | null;
  /** Latest git status of the active workspace; null → not fetched yet. */
  gitStatus: GitStatus | null;

  // --- actions ---
  bootstrap(): Promise<void>;
  applyEvent(event: SessionEvent): void;

  toggleSidebar(): void;
  setSidebarWidth(px: number): void;
  toggleTerminal(): void;
  toggleContentPanel(): void;
  setContentPanelTab(tab: ContentPanelTab): void;
  /** Open the panel, optionally switching to a tab. */
  openContentPanel(tab?: ContentPanelTab): void;
  setTerminalHeight(px: number): void;
  setContentPanelWidth(px: number): void;
  /** Pin a file's diff into the Diffs pane and reveal it. */
  showDiff(diff: SelectedDiff): void;
  setGitStatus(status: GitStatus): void;
  /** Fetch git status once (initial populate; the watcher keeps it live). */
  refreshGit(): Promise<void>;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  setHelpOpen(open: boolean): void;
  setModelPickerOpen(open: boolean): void;
  setEffortPickerOpen(open: boolean): void;
  setInput(v: string): void;
  setSettings(s: AppSettings): void;
  openWorkspace(): Promise<void>;
  removeWorkspace(root: string): Promise<void>;

  viewSubagent(sessionId: string): void;
  exitSubagent(): void;
  navigateSubagentBack(): void;
  navigateSubagentForward(): void;
  navigateBack(): void;
  navigateForward(): void;

  refreshSessions(): Promise<void>;
  createSession(workspaceRoot?: string | null): Promise<void>;
  activateSession(id: string, recordHistory?: boolean, historyIndex?: number): Promise<void>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  exportSession(id: string): Promise<void>;

  send(text: string): Promise<void>;
  abort(): void;
  setPreset(preset: PermissionPreset): void;
  setMode(mode: AgentMode): void;
  setModel(model: ModelRef): void;
  /** Set the reasoning effort for the current model (undefined clears to default). */
  setEffort(effort: string | undefined): void;
  refreshProviders(): Promise<void>;
  replyPermission(requestId: string, reply: PermissionReply, message?: string): void;
  answerQuestion(requestId: string, answers: string[][]): void;
  rejectQuestion(requestId: string): void;
  systemNote(text: string, error?: boolean): void;

  newTerminal(): Promise<void>;
  registerTerm(id: string): void;
  closeTerm(id: string): void;
  setActiveTerm(id: string): void;
}

export type SettingsSection =
  | "general"
  | "providers"
  | "workspace"
  | "permissions"
  | "appearance"
  | "advanced";

const presetToMode = (p: PermissionPreset): AgentMode => (p === "plan" ? "plan" : "build");

/** The persisted (stale-dropped) reasoning effort for a model given current providers/settings. */
function storedEffort(
  state: Pick<AppState, "providers" | "settings">,
  model: ModelRef | null,
): string | undefined {
  if (!model || !state.providers) return undefined;
  const stored = state.settings?.reasoningEfforts?.[modelKey(model)];
  return resolveEffort(stored, effortsForModel(state.providers, model));
}

function replayRecords(records: SessionRecord[]): TranscriptItem[] {
  let items: TranscriptItem[] = [];
  for (const rec of records) {
    if (rec.kind === "user") items = [...items, userItem(rec.text)];
    else items = foldEvent(items, rec.event);
  }
  return items;
}

const EMPTY_USAGE: SessionUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

/** Fold a turn's usage into a running total (missing fields count as zero). */
function addUsage(total: SessionUsage, usage: TokenUsage | undefined): SessionUsage {
  if (!usage) return total;
  return {
    inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
    totalTokens: total.totalTokens + (usage.totalTokens ?? 0),
  };
}

/**
 * Seed the running total + last-turn usage from a session's persisted records.
 * Subagent finish usage (wrapped in `subagent-event`) is folded into the
 * session total too, but never into `turnUsage` — the context meter tracks only
 * the parent session's own window.
 */
function sumUsage(records: SessionRecord[]): { sessionUsage: SessionUsage; turnUsage: TokenUsage | null } {
  let sessionUsage = EMPTY_USAGE;
  let turnUsage: TokenUsage | null = null;
  for (const rec of records) {
    if (rec.kind !== "event") continue;
    const event = rec.event;
    if (event.type === "finish" && event.usage) {
      sessionUsage = addUsage(sessionUsage, event.usage);
      turnUsage = event.usage;
    } else if (event.type === "subagent-event" && event.event.type === "finish") {
      sessionUsage = addUsage(sessionUsage, event.event.usage);
    }
  }
  return { sessionUsage, turnUsage };
}

export const useApp = create<AppState>((set, get) => ({
  settings: null,
  loaded: false,

  sidebarOpen: true,
  sidebarWidth: 290,
  terminalOpen: false,
  terminalHeight: 260,
  contentPanelOpen: false,
  contentPanelWidth: 320,
  contentPanelTab: "overview",
  settingsOpen: false,
  settingsSection: "general",
  helpOpen: false,
  modelPickerOpen: false,
  effortPickerOpen: false,

  sessions: [],
  activeId: null,
  subagentView: null,
  subagentHistory: [null],
  subagentHistoryIndex: 0,
  sessionHistory: [],
  sessionHistoryIndex: -1,

  items: [],
  busy: false,
  turnUsage: null,
  sessionUsage: EMPTY_USAGE,
  preset: "ask",
  model: null,
  effort: undefined,
  providers: null,
  recentModels: [],
  permissionQueue: [],
  questionQueue: [],
  input: "",

  termTabs: [],
  activeTermId: null,

  selectedDiff: null,
  gitStatus: null,

  async bootstrap() {
    const settings = await window.cozy.getSettings();
    const providers = await window.cozy.providers.list();
    const configured = Boolean(settings?.workspaceRoot && providers.connected.length > 0);
    set({
      settings,
      providers,
      recentModels: settings?.recentModels ?? [],
      loaded: true,
      settingsOpen: !configured,
      settingsSection: providers.connected.length ? "general" : "providers",
    });
    const sessions = await window.cozy.listSessions();
    set({ sessions });
    if (configured) {
      // Activate (or create) the most-recent session.
      const snap = sessions[0]
        ? await window.cozy.activateSession(sessions[0].id)
        : await window.cozy.createSession();
      set({
        activeId: snap.meta.id,
        items: replayRecords(snap.records),
        ...sumUsage(snap.records),
        preset: snap.meta.preset,
        model: snap.meta.model,
        effort: storedEffort(get(), snap.meta.model),
        busy: false,
        sessionHistory: [snap.meta.id],
        sessionHistoryIndex: 0,
      });
      void get().refreshSessions();
    }
  },

  applyEvent(event) {
    set((s) => ({ items: foldEvent(s.items, event) }));
    if (event.type === "mode-change") {
      // Keep the pill honest if the mode changed underneath us.
      set((s) => ({ preset: event.mode === "plan" ? "plan" : s.preset === "plan" ? "ask" : s.preset }));
    }
    if (event.type === "permission-asked") {
      set((s) => ({ permissionQueue: [...s.permissionQueue, event.request] }));
    }
    if (event.type === "permission-replied") {
      // Covers cascade-reject and always-grant of siblings too — no extra logic.
      set((s) => ({ permissionQueue: s.permissionQueue.filter((r) => r.id !== event.requestId) }));
    }
    if (event.type === "question-asked") {
      set((s) => ({ questionQueue: [...s.questionQueue, event.request] }));
    }
    if (event.type === "question-answered" || event.type === "question-rejected") {
      set((s) => ({ questionQueue: s.questionQueue.filter((r) => r.id !== event.requestId) }));
    }
    if (event.type === "effort-change") set({ effort: event.effort });
    if (event.type === "finish") {
      set((s) => ({
        busy: false,
        turnUsage: event.usage ?? s.turnUsage,
        sessionUsage: addUsage(s.sessionUsage, event.usage),
      }));
    }
    // Subagent turns bill into the session total (not the parent's context meter).
    if (event.type === "subagent-event" && event.event.type === "finish") {
      const usage = event.event.usage;
      if (usage) set((s) => ({ sessionUsage: addUsage(s.sessionUsage, usage) }));
    }
    if (event.type === "error") set({ busy: false });
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (px) => set({ sidebarWidth: Math.max(200, Math.min(450, px)) }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  toggleContentPanel: () => {
    const next = !get().contentPanelOpen;
    set({ contentPanelOpen: next });
    if (next && get().contentPanelTab === "git") void get().refreshGit();
  },
  setContentPanelTab: (tab) => {
    set({ contentPanelTab: tab });
    if (tab === "git") void get().refreshGit();
  },
  openContentPanel: (tab) => {
    set((s) => ({ contentPanelOpen: true, contentPanelTab: tab ?? s.contentPanelTab }));
    if ((tab ?? get().contentPanelTab) === "git") void get().refreshGit();
  },
  setTerminalHeight: (px) => set({ terminalHeight: Math.max(120, Math.min(600, px)) }),
  setContentPanelWidth: (px) => set({ contentPanelWidth: Math.max(200, Math.min(600, px)) }),
  showDiff: (diff) => set({ selectedDiff: diff, contentPanelTab: "diffs", contentPanelOpen: true }),
  setGitStatus: (status) => set({ gitStatus: status }),
  async refreshGit() {
    try {
      set({ gitStatus: await window.cozy.git.status() });
    } catch {
      // Non-fatal; the pane keeps its last snapshot.
    }
  },
  openSettings: (section = "general") => set({ settingsOpen: true, settingsSection: section }),
  closeSettings: () => set({ settingsOpen: false }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
  setEffortPickerOpen: (open) => set({ effortPickerOpen: open }),
  setInput: (v) => set({ input: v }),
  setSettings: (s) => set({ settings: s }),

  async openWorkspace() {
    const root = await window.cozy.pickWorkspace();
    const settings = get().settings;
    if (!root || !settings) return;
    const next = {
      ...settings,
      workspaceRoot: root,
      openWorkspaceRoots: workspaceRoots(root, settings.openWorkspaceRoots),
    };
    set({ settings: next });
    await window.cozy.saveSettings(next);
  },

  async removeWorkspace(root) {
    const settings = get().settings;
    if (!settings) return;
    const openWorkspaceRoots = (settings.openWorkspaceRoots ?? [settings.workspaceRoot]).filter((item) => item !== root);
    // Keep one project as the default target for global New chat.
    if (openWorkspaceRoots.length === 0) return;
    const next = {
      ...settings,
      workspaceRoot: settings.workspaceRoot === root ? openWorkspaceRoots[0]! : settings.workspaceRoot,
      openWorkspaceRoots,
    };
    set({ settings: next });
    await window.cozy.saveSettings(next);
  },

  // Read-only drill-in into a running/finished subagent. Does NOT touch the live
  // main-process session, so the subagent keeps running in the background.
  viewSubagent: (sessionId) =>
    set((s) => {
      if (s.subagentView === sessionId) return s;
      const subagentHistory = [...s.subagentHistory.slice(0, s.subagentHistoryIndex + 1), sessionId];
      return { subagentView: sessionId, subagentHistory, subagentHistoryIndex: subagentHistory.length - 1 };
    }),
  exitSubagent: () => get().navigateSubagentBack(),
  navigateSubagentBack: () =>
    set((s) => {
      if (s.subagentHistoryIndex === 0) return s;
      const subagentHistoryIndex = s.subagentHistoryIndex - 1;
      return { subagentHistoryIndex, subagentView: s.subagentHistory[subagentHistoryIndex] ?? null };
    }),
  navigateSubagentForward: () =>
    set((s) => {
      if (s.subagentHistoryIndex === s.subagentHistory.length - 1) return s;
      const subagentHistoryIndex = s.subagentHistoryIndex + 1;
      return { subagentHistoryIndex, subagentView: s.subagentHistory[subagentHistoryIndex] ?? null };
    }),
  navigateBack: () => {
    const { subagentHistoryIndex, sessionHistoryIndex } = get();
    if (subagentHistoryIndex > 0) {
      get().navigateSubagentBack();
      return;
    }
    if (sessionHistoryIndex > 0) {
      const nextIndex = sessionHistoryIndex - 1;
      const id = get().sessionHistory[nextIndex];
      if (id) void get().activateSession(id, false, nextIndex);
    }
  },
  navigateForward: () => {
    const { subagentHistory, subagentHistoryIndex, sessionHistory, sessionHistoryIndex } = get();
    if (subagentHistoryIndex < subagentHistory.length - 1) {
      get().navigateSubagentForward();
      return;
    }
    if (sessionHistoryIndex < sessionHistory.length - 1) {
      const nextIndex = sessionHistoryIndex + 1;
      const id = sessionHistory[nextIndex];
      if (id) void get().activateSession(id, false, nextIndex);
    }
  },

  async refreshSessions() {
    set({ sessions: await window.cozy.listSessions() });
  },

  async createSession(workspaceRoot) {
    const root = workspaceRoot === undefined ? (get().settings?.workspaceRoot ?? null) : workspaceRoot;
    const empty = emptySessionForWorkspace(get().sessions, root);
    if (empty) {
      if (empty.id !== get().activeId) await get().activateSession(empty.id);
      return;
    }

    const snap = await window.cozy.createSession({ workspaceRoot: root });
    set({
      activeId: snap.meta.id,
      items: replayRecords(snap.records),
      ...sumUsage(snap.records),
      preset: snap.meta.preset,
      model: snap.meta.model,
      effort: storedEffort(get(), snap.meta.model),
      busy: false,
      input: "",
      permissionQueue: [],
      questionQueue: [],
      subagentView: null,
      subagentHistory: [null],
      subagentHistoryIndex: 0,
      sessionHistory: [...get().sessionHistory.slice(0, get().sessionHistoryIndex + 1), snap.meta.id],
      sessionHistoryIndex: get().sessionHistoryIndex + 1,
    });
    await updateLastWorkspace(get, set, snap.meta.workspaceRoot);
    await get().refreshSessions();
  },

  async activateSession(id, recordHistory = true, historyIndex) {
    if (id === get().activeId) return;
    const snap = await window.cozy.activateSession(id);
    const { sessionHistory, sessionHistoryIndex } = get();
    const nextHistory = recordHistory
      ? [...sessionHistory.slice(0, sessionHistoryIndex + 1), snap.meta.id]
      : sessionHistory;
    const nextHistoryIndex = recordHistory ? nextHistory.length - 1 : (historyIndex ?? sessionHistory.indexOf(snap.meta.id));
    set({
      activeId: snap.meta.id,
      items: replayRecords(snap.records),
      ...sumUsage(snap.records),
      preset: snap.meta.preset,
      model: snap.meta.model,
      effort: storedEffort(get(), snap.meta.model),
      busy: false,
      input: "",
      permissionQueue: [],
      questionQueue: [],
      subagentView: null,
      subagentHistory: [null],
      subagentHistoryIndex: 0,
      sessionHistory: nextHistory,
      sessionHistoryIndex: nextHistoryIndex,
    });
    await updateLastWorkspace(get, set, snap.meta.workspaceRoot);
  },

  async deleteSession(id) {
    const snap = await window.cozy.deleteSession(id);
    const sessionHistory = get().sessionHistory.filter((sessionId) => sessionId !== id);
    if (snap) {
      if (!sessionHistory.includes(snap.meta.id)) sessionHistory.push(snap.meta.id);
      set({
        activeId: snap.meta.id,
        items: replayRecords(snap.records),
        ...sumUsage(snap.records),
        preset: snap.meta.preset,
        model: snap.meta.model,
        effort: storedEffort(get(), snap.meta.model),
        busy: false,
        permissionQueue: [],
        questionQueue: [],
        subagentView: null,
        subagentHistory: [null],
        subagentHistoryIndex: 0,
        sessionHistory,
        sessionHistoryIndex: sessionHistory.lastIndexOf(snap.meta.id),
      });
    } else {
      set((s) => ({ sessionHistory, sessionHistoryIndex: sessionHistory.lastIndexOf(s.activeId ?? "") }));
    }
    await get().refreshSessions();
  },

  async renameSession(id, title) {
    await window.cozy.renameSession(id, title);
    await get().refreshSessions();
  },

  async exportSession(id) {
    await window.cozy.exportSession(id);
  },

  async send(text) {
    if (!text.trim() || get().busy) return;
    set((s) => ({ items: [...s.items, userItem(text)], busy: true }));
    const res = await window.cozy.send(text);
    if (!res.ok) {
      set((s) => ({
        busy: false,
        items: [...s.items, { id: `err-${s.items.length}`, kind: "error", text: res.error ?? "Unknown error" }],
      }));
    }
    void get().refreshSessions();
  },

  abort: () => {
    // Providers may take time to acknowledge an abort. End the local turn now
    // so the stop control and transcript never remain visually active.
    set((s) => ({
      busy: false,
      items: foldEvent(s.items, { type: "finish", reason: "abort" }),
      permissionQueue: [],
      questionQueue: [],
    }));
    void window.cozy.abort();
  },

  setPreset(preset) {
    set({ preset });
    void window.cozy.setPreset(preset);
    void get().refreshSessions();
  },

  setMode(mode) {
    const preset: PermissionPreset = mode === "plan" ? "plan" : "ask";
    get().setPreset(preset);
  },

  setModel(model) {
    const recentModels = [model, ...get().recentModels.filter(
      (item) => item.providerID !== model.providerID || item.modelID !== model.modelID,
    )].slice(0, 8);
    set({ model, recentModels, modelPickerOpen: false });
    void window.cozy.setModel(model);
    const settings = get().settings;
    if (settings) {
      const next = { ...settings, recentModels };
      set({ settings: next });
      void window.cozy.saveSettings(next);
    }
    // Restore (stale-dropping) the new model's effort and push it to the live
    // session, since main's same-provider setModel does not re-apply effort.
    const restored = storedEffort(get(), model);
    set({ effort: restored });
    void window.cozy.setEffort(restored);
  },

  setEffort(effort) {
    const { model, providers } = get();
    const valid = resolveEffort(effort, effortsForModel(providers ?? { all: [], connected: [] }, model));
    set({ effort: valid });
    void window.cozy.setEffort(valid);
    const settings = get().settings;
    if (settings && model) {
      const efforts = { ...settings.reasoningEfforts };
      if (valid) efforts[modelKey(model)] = valid;
      else delete efforts[modelKey(model)];
      const next = { ...settings, reasoningEfforts: efforts };
      set({ settings: next });
      void window.cozy.saveSettings(next);
    }
  },

  async refreshProviders() {
    set({ providers: await window.cozy.providers.list() });
  },

  replyPermission(requestId, reply, message) {
    // Optimistically drop from the queue; the replied event confirms it (idempotent).
    set((s) => ({ permissionQueue: s.permissionQueue.filter((r) => r.id !== requestId) }));
    void window.cozy.replyPermission({ requestId, reply, message });
  },

  answerQuestion(requestId, answers) {
    set((s) => ({ questionQueue: s.questionQueue.filter((r) => r.id !== requestId) }));
    void window.cozy.replyQuestion({ requestId, answers });
  },

  rejectQuestion(requestId) {
    set((s) => ({ questionQueue: s.questionQueue.filter((r) => r.id !== requestId) }));
    void window.cozy.replyQuestion({ requestId, answers: null });
  },

  systemNote(text, error) {
    set((s) => ({
      items: [
        ...s.items,
        { id: `note-${s.items.length}`, kind: error ? "error" : "system", text },
      ],
    }));
  },

  async newTerminal() {
    const { termId } = await window.cozy.term.create({ cols: 80, rows: 24 });
    get().registerTerm(termId);
  },

  registerTerm: (id) =>
    set((s) => ({
      termTabs: [...s.termTabs, { id, title: "Terminal" }],
      activeTermId: id,
      terminalOpen: true,
    })),

  closeTerm(id) {
    void window.cozy.term.kill(id);
    set((s) => {
      const termTabs = s.termTabs.filter((t) => t.id !== id);
      const activeTermId =
        s.activeTermId === id ? (termTabs[termTabs.length - 1]?.id ?? null) : s.activeTermId;
      return { termTabs, activeTermId, terminalOpen: termTabs.length > 0 };
    });
  },

  setActiveTerm: (id) => set({ activeTermId: id }),
}));

export { presetToMode };
export type { TermTab };

async function updateLastWorkspace(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  root: string | null,
): Promise<void> {
  const settings = get().settings;
  if (!root || !settings || settings.workspaceRoot === root) return;
  const next = {
    ...settings,
    workspaceRoot: root,
    openWorkspaceRoots: workspaceRoots(root, settings.openWorkspaceRoots),
  };
  set({ settings: next });
  await window.cozy.saveSettings(next);
}
