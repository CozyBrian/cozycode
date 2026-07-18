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
  SessionEventEnvelope,
  SessionSnapshot,
} from "../../../shared/ipc.ts";

export type ContentPanelTab = "overview" | "diffs" | "git";

/** A file diff pinned into the Diffs pane (from a chat card or the Git pane). */
export interface SelectedDiff {
  path: string;
  patch: string;
  source: "chat" | "git";
}

export interface EditingUserTurn {
  sessionId: string;
  turnId: string;
  text: string;
}

/** Running token totals for the active session. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SessionViewState {
  /** Monotonic renderer-local revision used to reject stale activation snapshots. */
  revision: number;
  items: TranscriptItem[];
  /** The addressed send promise is still settling in the main process. */
  running: boolean;
  busy: boolean;
  /** A completed background turn has not been viewed yet. */
  backgroundComplete: boolean;
  turnUsage: TokenUsage | null;
  sessionUsage: SessionUsage;
  preset: PermissionPreset;
  model: ModelRef | null;
  effort: string | undefined;
  permissionQueue: PermissionRequest[];
  questionQueue: QuestionRequest[];
  input: string;
}

export function isSessionRunningInBackground(
  state: Pick<AppState, "activeId" | "sessionViews">,
  sessionId: string,
): boolean {
  return Boolean(state.sessionViews[sessionId]?.running) && state.activeId !== sessionId;
}

export function newChatWorkspace(
  state: Pick<AppState, "settings" | "sessions">,
): string | null {
  const last = state.settings?.lastToggledWorkspaceRoot;
  if (
    last &&
    (state.settings?.openWorkspaceRoots?.includes(last) ||
      state.sessions.some((session) => session.workspaceRoot === last))
  ) {
    return last;
  }
  return state.settings?.workspaceRoot ?? null;
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
  /** Settings was left through Back/Chats and can be restored with Forward. */
  settingsForwardAvailable: boolean;
  settingsSection: SettingsSection;
  helpOpen: boolean;
  modelPickerOpen: boolean;
  effortPickerOpen: boolean;
  editingUserTurn: EditingUserTurn | null;

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
  /** Live renderer state retained for every visited or running session. */
  sessionViews: Record<string, SessionViewState>;

  // active chat
  revision: number;
  items: TranscriptItem[];
  /** The selected session still has a main-process send promise in flight. */
  running: boolean;
  busy: boolean;
  backgroundComplete: boolean;
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
  applyEvent(envelope: SessionEventEnvelope): void;

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
  reorderWorkspaces(roots: string[]): Promise<void>;
  setLastToggledWorkspace(root: string): Promise<void>;

  viewSubagent(sessionId: string): void;
  exitSubagent(): void;
  navigateSubagentBack(): void;
  navigateSubagentForward(): void;
  navigateBack(): void;
  navigateForward(): void;

  refreshSessions(): Promise<void>;
  createSession(workspaceRoot?: string | null): Promise<string | null>;
  activateSession(id: string, recordHistory?: boolean, historyIndex?: number): Promise<void>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  exportSession(id: string): Promise<void>;
  forkSession(id: string): Promise<void>;
  forkFromTurn(turnId: string, text: string): Promise<void>;
  setEditingUserTurn(turn: EditingUserTurn | null): void;
  editUserTurn(turnId: string, text: string): Promise<boolean>;

  send(text: string, kind?: "prompt" | "shell"): Promise<void>;
  abort(): void;
  setPreset(preset: PermissionPreset): void;
  setMode(mode: AgentMode): void;
  setModel(model: ModelRef): void;
  /** Set the reasoning effort for the current model (undefined clears to default). */
  setEffort(effort: string | undefined): void;
  applyProviders(providers: ProviderList): Promise<void>;
  refreshProviders(): Promise<void>;
  replyPermission(requestId: string, reply: PermissionReply, message?: string, sessionId?: string): void;
  answerQuestion(requestId: string, answers: string[][], sessionId?: string): void;
  rejectQuestion(requestId: string, sessionId?: string): void;
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
    if (rec.kind === "user") items = [...items, userItem(rec.text, rec.turnId)];
    else items = foldEvent(items, rec.event);
  }
  return items;
}

const EMPTY_USAGE: SessionUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function emptyActiveState(
  state: Pick<AppState, "providers" | "settings" | "recentModels">,
): Partial<AppState> {
  const model = state.providers?.defaultModel ?? state.recentModels[0] ?? null;
  return {
    activeId: null,
    revision: 0,
    items: [],
    running: false,
    busy: false,
    backgroundComplete: false,
    turnUsage: null,
    sessionUsage: EMPTY_USAGE,
    preset: "ask",
    model,
    effort: storedEffort(state, model),
    permissionQueue: [],
    questionQueue: [],
    input: "",
    subagentView: null,
    subagentHistory: [null],
    subagentHistoryIndex: 0,
  };
}

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

function viewFromSnapshot(
  snapshot: SessionSnapshot,
  state: Pick<AppState, "providers" | "settings">,
  input = "",
): SessionViewState {
  return {
    revision: 0,
    items: replayRecords(snapshot.records),
    running: snapshot.running,
    busy: snapshot.running,
    backgroundComplete: false,
    ...sumUsage(snapshot.records),
    preset: snapshot.meta.preset,
    model: snapshot.meta.model,
    effort: storedEffort(state, snapshot.meta.model),
    permissionQueue: snapshot.permissionQueue,
    questionQueue: snapshot.questionQueue,
    input,
  };
}

function activeView(state: AppState): SessionViewState {
  return {
    revision: state.revision,
    items: state.items,
    running: state.running,
    busy: state.busy,
    backgroundComplete: state.backgroundComplete,
    turnUsage: state.turnUsage,
    sessionUsage: state.sessionUsage,
    preset: state.preset,
    model: state.model,
    effort: state.effort,
    permissionQueue: state.permissionQueue,
    questionQueue: state.questionQueue,
    input: state.input,
  };
}

function foldViewEvent(view: SessionViewState, event: SessionEvent): SessionViewState {
  let next = { ...view, items: foldEvent(view.items, event) };
  if (event.type === "mode-change") {
    next.preset = event.mode === "plan" ? "plan" : next.preset === "plan" ? "ask" : next.preset;
  } else if (event.type === "permission-asked") {
    if (!next.permissionQueue.some((request) => request.id === event.request.id)) {
      next.permissionQueue = [...next.permissionQueue, event.request];
    }
  } else if (event.type === "permission-replied") {
    next.permissionQueue = next.permissionQueue.filter((request) => request.id !== event.requestId);
  } else if (event.type === "question-asked") {
    if (!next.questionQueue.some((request) => request.id === event.request.id)) {
      next.questionQueue = [...next.questionQueue, event.request];
    }
  } else if (event.type === "question-answered" || event.type === "question-rejected") {
    next.questionQueue = next.questionQueue.filter((request) => request.id !== event.requestId);
  } else if (event.type === "effort-change") {
    next.effort = event.effort;
  } else if (event.type === "finish") {
    next.busy = false;
    next.turnUsage = event.usage ?? next.turnUsage;
    next.sessionUsage = addUsage(next.sessionUsage, event.usage);
  } else if (event.type === "subagent-event" && event.event.type === "finish") {
    next.sessionUsage = addUsage(next.sessionUsage, event.event.usage);
  } else if (event.type === "error") {
    next.busy = false;
  } else if (event.type === "session-settled") {
    next.running = false;
    next.busy = false;
  }
  return next;
}

function updateView(
  state: AppState,
  sessionId: string,
  update: (view: SessionViewState) => SessionViewState,
): Partial<AppState> {
  const current = state.sessionViews[sessionId] ?? (state.activeId === sessionId ? activeView(state) : null);
  if (!current) return {};
  const next = { ...update(current), revision: current.revision + 1 };
  return {
    sessionViews: { ...state.sessionViews, [sessionId]: next },
    ...(state.activeId === sessionId ? next : {}),
  };
}

let activationSequence = 0;

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
  settingsForwardAvailable: false,
  settingsSection: "general",
  helpOpen: false,
  modelPickerOpen: false,
  effortPickerOpen: false,
  editingUserTurn: null,

  sessions: [],
  activeId: null,
  subagentView: null,
  subagentHistory: [null],
  subagentHistoryIndex: 0,
  sessionHistory: [],
  sessionHistoryIndex: -1,
  sessionViews: {},

  revision: 0,
  items: [],
  running: false,
  busy: false,
  backgroundComplete: false,
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
    const ready = providers.connected.length > 0;
    const sessions = await window.cozy.listSessions();
    if (ready) {
      const continueSession = settings?.startupView === "continue-last-session" && sessions[0];
      if (!continueSession) {
        set({
          ...emptyActiveState({ settings, providers, recentModels: settings?.recentModels ?? [] }),
          settings,
          providers,
          recentModels: settings?.recentModels ?? [],
          sessions,
          loaded: true,
          settingsOpen: false,
          settingsForwardAvailable: false,
          settingsSection: "general",
          sessionViews: {},
          sessionHistory: [],
          sessionHistoryIndex: -1,
        });
        return;
      }
      const snap = await window.cozy.activateSession(continueSession.id);
      const view = viewFromSnapshot(snap, { settings, providers });
      set({
        activeId: snap.meta.id,
        settings,
        providers,
        recentModels: settings?.recentModels ?? [],
        sessions,
        loaded: true,
        settingsOpen: false,
        settingsForwardAvailable: false,
        settingsSection: "general",
        ...view,
        sessionViews: { [snap.meta.id]: view },
        sessionHistory: [snap.meta.id],
        sessionHistoryIndex: 0,
      });
      void get().refreshSessions();
      return;
    }
    set({
      settings,
      providers,
      recentModels: settings?.recentModels ?? [],
      sessions,
      loaded: true,
      settingsOpen: true,
      settingsForwardAvailable: false,
      settingsSection: "providers",
    });
  },

  applyEvent({ sessionId, event }) {
    set((state) =>
      updateView(state, sessionId, (view) => {
        const next = foldViewEvent(view, event);
        if (
          ((event.type === "finish" && event.reason !== "abort") || event.type === "error") &&
          state.activeId !== sessionId
        ) {
          next.backgroundComplete = true;
        }
        return next;
      }),
    );
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
  openSettings: (section = "general") =>
    set({
      settingsOpen: true,
      settingsForwardAvailable: false,
      settingsSection: section,
      contentPanelOpen: false,
      editingUserTurn: null,
    }),
  closeSettings: () =>
    set((state) =>
      state.providers?.connected.length
        ? { settingsOpen: false, settingsForwardAvailable: true }
        : state,
    ),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
  setEffortPickerOpen: (open) => set({ effortPickerOpen: open }),
  setInput: (input) => {
    const id = get().activeId;
    if (!id) return set({ input });
    set((state) => updateView(state, id, (view) => ({ ...view, input })));
  },
  setSettings: (s) => set({ settings: s }),

  async openWorkspace() {
    const root = await window.cozy.pickWorkspace();
    if (!root) return;
    const current = get().settings;
    const next: AppSettings = current
      ? {
          ...current,
          workspaceRoot: root,
          openWorkspaceRoots: workspaceRoots(root, current.openWorkspaceRoots),
        }
      : {
          workspaceRoot: root,
          openWorkspaceRoots: [root],
          recentModels: get().recentModels,
        };
    set({ settings: next });
    await window.cozy.saveSettings(next);
  },

  async removeWorkspace(root) {
    const settings = get().settings;
    if (!settings) return;
    const openWorkspaceRoots = workspaceRoots(
      settings.workspaceRoot,
      settings.openWorkspaceRoots,
    ).filter((item) => item !== root);
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

  async reorderWorkspaces(roots) {
    const settings = get().settings;
    if (!settings) return;
    const current = workspaceRoots(settings.workspaceRoot, settings.openWorkspaceRoots);
    if (roots.length !== current.length || roots.some((root) => !current.includes(root))) return;
    const next = { ...settings, openWorkspaceRoots: roots };
    set({ settings: next });
    await window.cozy.saveSettings(next);
  },

  async setLastToggledWorkspace(root) {
    const current = get().settings ?? {};
    if (current.lastToggledWorkspaceRoot === root) return;
    const next = {
      ...current,
      lastToggledWorkspaceRoot: root,
    };
    set({ settings: next });
    const saved = await window.cozy.saveSettings(next);
    if (get().settings?.lastToggledWorkspaceRoot === root) set({ settings: saved });
  },

  // Read-only drill-in into a running/finished subagent. Does NOT touch the live
  // main-process session, so the subagent keeps running in the background.
  viewSubagent: (sessionId) =>
    set((s) => {
      if (s.subagentView === sessionId) return s;
      const subagentHistory = [...s.subagentHistory.slice(0, s.subagentHistoryIndex + 1), sessionId];
      return {
        subagentView: sessionId,
        subagentHistory,
        subagentHistoryIndex: subagentHistory.length - 1,
        editingUserTurn: null,
      };
    }),
  exitSubagent: () => get().navigateSubagentBack(),
  navigateSubagentBack: () =>
    set((s) => {
      if (s.subagentHistoryIndex === 0) return s;
      const subagentHistoryIndex = s.subagentHistoryIndex - 1;
      return {
        subagentHistoryIndex,
        subagentView: s.subagentHistory[subagentHistoryIndex] ?? null,
        editingUserTurn: null,
      };
    }),
  navigateSubagentForward: () =>
    set((s) => {
      if (s.subagentHistoryIndex === s.subagentHistory.length - 1) return s;
      const subagentHistoryIndex = s.subagentHistoryIndex + 1;
      return {
        subagentHistoryIndex,
        subagentView: s.subagentHistory[subagentHistoryIndex] ?? null,
        editingUserTurn: null,
      };
    }),
  navigateBack: () => {
    if (get().settingsOpen) {
      get().closeSettings();
      return;
    }
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
    if (get().settingsOpen) return;
    const {
      subagentHistory,
      subagentHistoryIndex,
      sessionHistory,
      sessionHistoryIndex,
      settingsForwardAvailable,
    } = get();
    if (subagentHistoryIndex < subagentHistory.length - 1) {
      get().navigateSubagentForward();
      return;
    }
    if (sessionHistoryIndex < sessionHistory.length - 1) {
      const nextIndex = sessionHistoryIndex + 1;
      const id = sessionHistory[nextIndex];
      if (id) void get().activateSession(id, false, nextIndex);
      return;
    }
    if (settingsForwardAvailable) {
      set({
        settingsOpen: true,
        settingsForwardAvailable: false,
        contentPanelOpen: false,
        editingUserTurn: null,
      });
    }
  },

  async refreshSessions() {
    set({ sessions: await window.cozy.listSessions() });
  },

  async createSession(workspaceRoot) {
    const root = workspaceRoot === undefined ? newChatWorkspace(get()) : workspaceRoot;
    const empty = emptySessionForWorkspace(get().sessions, root);
    if (empty) {
      if (empty.id !== get().activeId) await get().activateSession(empty.id);
      else set({ settingsOpen: false, settingsForwardAvailable: false });
      return get().activeId === empty.id ? empty.id : null;
    }

    const request = ++activationSequence;
    const snap = await window.cozy.createSession({ workspaceRoot: root });
    const view = viewFromSnapshot(snap, get());
    if (request !== activationSequence) {
      set((state) => ({
        sessionViews: { ...state.sessionViews, [snap.meta.id]: view },
      }));
      await get().refreshSessions();
      return snap.meta.id;
    }
    set({
      activeId: snap.meta.id,
      ...view,
      sessionViews: { ...get().sessionViews, [snap.meta.id]: view },
      subagentView: null,
      subagentHistory: [null],
      subagentHistoryIndex: 0,
      settingsOpen: false,
      settingsForwardAvailable: false,
      editingUserTurn: null,
      sessionHistory: [...get().sessionHistory.slice(0, get().sessionHistoryIndex + 1), snap.meta.id],
      sessionHistoryIndex: get().sessionHistoryIndex + 1,
    });
    await updateLastWorkspace(get, set, snap.meta.workspaceRoot);
    await get().refreshSessions();
    return snap.meta.id;
  },

  async activateSession(id, recordHistory = true, historyIndex) {
    if (id === get().activeId) {
      set((state) => ({
        settingsOpen: false,
        settingsForwardAvailable: false,
        backgroundComplete: false,
        sessionViews: state.sessionViews[id]
          ? {
              ...state.sessionViews,
              [id]: { ...state.sessionViews[id], backgroundComplete: false },
            }
          : state.sessionViews,
      }));
      return;
    }
    const request = ++activationSequence;
    const state = get();
    const { sessionHistory, sessionHistoryIndex } = state;
    const nextHistory = recordHistory
      ? [...sessionHistory.slice(0, sessionHistoryIndex + 1), id]
      : sessionHistory;
    const nextHistoryIndex = recordHistory ? nextHistory.length - 1 : (historyIndex ?? sessionHistory.indexOf(id));
    const cached = state.sessionViews[id];
    const meta = state.sessions.find((session) => session.id === id);
    const optimisticView = cached ? { ...cached, backgroundComplete: false } : (meta
      ? viewFromSnapshot({
          meta,
          records: [],
          running: false,
          permissionQueue: [],
          questionQueue: [],
        }, state)
      : null);
    const optimisticRevision = optimisticView?.revision ?? -1;
    if (optimisticView) {
      set({
        activeId: id,
        ...optimisticView,
        sessionViews: { ...state.sessionViews, [id]: optimisticView },
        subagentView: null,
        subagentHistory: [null],
        subagentHistoryIndex: 0,
        settingsOpen: false,
        settingsForwardAvailable: recordHistory ? false : state.settingsForwardAvailable,
        editingUserTurn: null,
        sessionHistory: nextHistory,
        sessionHistoryIndex: nextHistoryIndex,
      });
    }

    const snap = await window.cozy.activateSession(id);
    if (request !== activationSequence) return;
    const latest = get().sessionViews[id];
    const changedDuringActivation = Boolean(latest && latest.revision !== optimisticRevision);
    const preserveLive = Boolean(latest && (cached || changedDuringActivation));
    const view = preserveLive && latest
      ? {
          ...latest,
          running: changedDuringActivation ? latest.running : snap.running,
          busy: changedDuringActivation ? latest.busy : snap.running ? latest.busy : false,
          preset: snap.meta.preset,
          model: snap.meta.model,
          effort: storedEffort(get(), snap.meta.model),
        }
      : viewFromSnapshot(snap, get());
    set({
      activeId: snap.meta.id,
      ...view,
      sessionViews: { ...get().sessionViews, [id]: view },
      subagentView: null,
      subagentHistory: [null],
      subagentHistoryIndex: 0,
      settingsOpen: false,
      settingsForwardAvailable: recordHistory ? false : get().settingsForwardAvailable,
      editingUserTurn: null,
      sessionHistory: nextHistory,
      sessionHistoryIndex: nextHistoryIndex,
    });
    await updateLastWorkspace(get, set, snap.meta.workspaceRoot);
  },

  async deleteSession(id) {
    const request = ++activationSequence;
    const wasActive = get().activeId === id;
    await window.cozy.deleteSession(id);
    const sessionHistory = get().sessionHistory.filter((sessionId) => sessionId !== id);
    const sessionViews = { ...get().sessionViews };
    delete sessionViews[id];
    if (request !== activationSequence) {
      set((state) => ({
        sessionViews,
        sessionHistory,
        sessionHistoryIndex: sessionHistory.lastIndexOf(state.activeId ?? ""),
        editingUserTurn: state.editingUserTurn?.sessionId === id ? null : state.editingUserTurn,
      }));
      await get().refreshSessions();
      return;
    }
    if (wasActive) {
      set({
        ...emptyActiveState(get()),
        sessionViews,
        sessionHistory,
        sessionHistoryIndex: -1,
        editingUserTurn: null,
      });
    } else {
      set((s) => ({
        sessionViews,
        sessionHistory,
        sessionHistoryIndex: sessionHistory.lastIndexOf(s.activeId ?? ""),
        editingUserTurn: s.editingUserTurn?.sessionId === id ? null : s.editingUserTurn,
      }));
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

  async forkSession(id) {
    const request = ++activationSequence;
    let snap: SessionSnapshot;
    try {
      snap = await window.cozy.forkSession(id);
    } catch (error) {
      get().systemNote(error instanceof Error ? error.message : String(error), true);
      return;
    }
    const view = viewFromSnapshot(snap, get());
    if (request !== activationSequence) {
      set((state) => ({ sessionViews: { ...state.sessionViews, [snap.meta.id]: view } }));
      await get().refreshSessions();
      return;
    }
    set((state) => ({
      activeId: snap.meta.id,
      ...view,
      sessionViews: { ...state.sessionViews, [snap.meta.id]: view },
      subagentView: null,
      subagentHistory: [null],
      subagentHistoryIndex: 0,
      sessionHistory: [
        ...state.sessionHistory.slice(0, state.sessionHistoryIndex + 1),
        snap.meta.id,
      ],
      sessionHistoryIndex: state.sessionHistoryIndex + 1,
      settingsOpen: false,
      settingsForwardAvailable: false,
      editingUserTurn: null,
    }));
    await get().refreshSessions();
  },

  async forkFromTurn(turnId, text) {
    const id = get().activeId;
    if (!id || get().running) return;
    const request = ++activationSequence;
    let snap: SessionSnapshot;
    try {
      snap = await window.cozy.forkFromTurn(id, turnId);
    } catch (error) {
      get().systemNote(error instanceof Error ? error.message : String(error), true);
      return;
    }
    const view = { ...viewFromSnapshot(snap, get(), text), input: text };
    if (request !== activationSequence) {
      set((state) => ({ sessionViews: { ...state.sessionViews, [snap.meta.id]: view } }));
      await get().refreshSessions();
      return;
    }
    set((state) => ({
      activeId: snap.meta.id,
      ...view,
      sessionViews: { ...state.sessionViews, [snap.meta.id]: view },
      subagentView: null,
      subagentHistory: [null],
      subagentHistoryIndex: 0,
      sessionHistory: [
        ...state.sessionHistory.slice(0, state.sessionHistoryIndex + 1),
        snap.meta.id,
      ],
      sessionHistoryIndex: state.sessionHistoryIndex + 1,
      settingsOpen: false,
      settingsForwardAvailable: false,
      editingUserTurn: null,
    }));
    await get().refreshSessions();
  },

  setEditingUserTurn: (turn) => set({ editingUserTurn: turn }),

  async editUserTurn(turnId, text) {
    const id = get().activeId;
    if (!id || get().running || !text.trim()) return false;
    const request = ++activationSequence;
    const current = get().sessionViews[id] ?? activeView(get());
    const index = current.items.findIndex(
      (item) => item.kind === "user" && item.turnId === turnId,
    );
    if (index < 0) return false;
    const replacementTurnId = crypto.randomUUID();
    set((state) => updateView(state, id, (view) => ({
      ...view,
      items: [...view.items.slice(0, index), userItem(text.trim(), replacementTurnId)],
      running: true,
      busy: true,
      turnUsage: null,
      permissionQueue: [],
      questionQueue: [],
    })));
    const result = await window.cozy.editTurn({
      sessionId: id,
      turnId,
      replacementTurnId,
      text: text.trim(),
    });
    if (!result.ok) {
      if (request !== activationSequence || get().activeId !== id) {
        set((state) => {
          const sessionViews = { ...state.sessionViews };
          delete sessionViews[id];
          return { sessionViews };
        });
        await get().refreshSessions();
        return false;
      }
      const snap = await window.cozy.activateSession(id);
      const view = viewFromSnapshot(snap, get(), current.input);
      set((state) => ({
        ...view,
        sessionViews: { ...state.sessionViews, [id]: view },
      }));
      get().systemNote(result.error ?? "Could not edit this message.", true);
      return false;
    }
    set((state) => ({
      ...updateView(state, id, (view) => ({ ...view, input: "" })),
      editingUserTurn:
        state.editingUserTurn?.sessionId === id
        && state.editingUserTurn.turnId === turnId
          ? null
          : state.editingUserTurn,
    }));
    await get().refreshSessions();
    return true;
  },

  async send(text, kind = "prompt") {
    let id = get().activeId;
    const pendingConfiguration = id
      ? null
      : { model: get().model, preset: get().preset, effort: get().effort };
    if (!id) {
      id = await get().createSession();
    }
    if (!id || !text.trim() || get().sessionViews[id]?.running) return;
    if (pendingConfiguration) {
      const view = get().sessionViews[id];
      if (pendingConfiguration.model && view?.model !== pendingConfiguration.model) {
        await window.cozy.setModel(id, pendingConfiguration.model);
      }
      if (view?.preset !== pendingConfiguration.preset) {
        await window.cozy.setPreset(id, pendingConfiguration.preset);
      }
      if (pendingConfiguration.effort) {
        await window.cozy.setEffort(id, pendingConfiguration.effort);
      }
      set((state) => updateView(state, id!, (current) => ({
        ...current,
        model: pendingConfiguration.model ?? current.model,
        preset: pendingConfiguration.preset,
        effort: pendingConfiguration.effort,
      })));
    }
    const turnId = crypto.randomUUID();
    const displayText = kind === "shell" ? `!${text}` : text;
    set((state) => updateView(state, id, (view) => ({
      ...view,
      items: [...view.items, userItem(displayText, turnId)],
      running: true,
      busy: true,
    })));
    const res = kind === "shell"
      ? await window.cozy.shell(id, text, turnId)
      : await window.cozy.send(id, text, turnId);
    set((state) => updateView(state, id, (view) => ({ ...view, running: false, busy: false })));
    if (!res.ok) {
      set((state) => updateView(state, id, (view) => ({
        ...view,
        busy: false,
        items: [...view.items, { id: `err-${view.items.length}`, kind: "error", text: res.error ?? "Unknown error" }],
      })));
    } else if (res.warnings?.length) {
      set((state) => updateView(state, id, (view) => ({
        ...view,
        items: [
          ...view.items,
          ...res.warnings!.map((warning, index) => ({
            id: `warning-${view.items.length}-${index}`,
            kind: "system" as const,
            text: warning,
          })),
        ],
      })));
    }
    void get().refreshSessions();
  },

  abort: () => {
    // Providers may take time to acknowledge an abort. End the local turn now
    // so the stop control and transcript never remain visually active.
    const id = get().activeId;
    if (!id) return;
    set((state) => updateView(state, id, (view) => ({
      ...view,
      busy: false,
      items: foldEvent(view.items, { type: "finish", reason: "abort" }),
      permissionQueue: [],
      questionQueue: [],
    })));
    void window.cozy.abort(id);
  },

  setPreset(preset) {
    const id = get().activeId;
    if (!id) {
      set({ preset });
      return;
    }
    set((state) => updateView(state, id, (view) => ({ ...view, preset })));
    void window.cozy.setPreset(id, preset);
    void get().refreshSessions();
  },

  setMode(mode) {
    const preset: PermissionPreset = mode === "plan" ? "plan" : "ask";
    get().setPreset(preset);
  },

  setModel(model) {
    const id = get().activeId;
    const recentModels = [model, ...get().recentModels.filter(
      (item) => item.providerID !== model.providerID || item.modelID !== model.modelID,
    )].slice(0, 8);
    const restored = storedEffort(get(), model);
    if (id) {
      set((state) => ({
        ...updateView(state, id, (view) => ({ ...view, model, effort: restored })),
        recentModels,
        modelPickerOpen: false,
      }));
      void window.cozy.setModel(id, model);
      void window.cozy.setEffort(id, restored);
    } else {
      set({ model, effort: restored, recentModels, modelPickerOpen: false });
    }
    const settings = get().settings ?? {};
    const next = { ...settings, recentModels };
    set({ settings: next });
    void window.cozy.saveSettings(next);
    // Restore (stale-dropping) the new model's effort and push it to the live
    // session, since main's same-provider setModel does not re-apply effort.
  },

  setEffort(effort) {
    const { activeId: id, model, providers } = get();
    const valid = resolveEffort(effort, effortsForModel(providers ?? { all: [], connected: [] }, model));
    if (id) {
      set((state) => updateView(state, id, (view) => ({ ...view, effort: valid })));
      void window.cozy.setEffort(id, valid);
    } else {
      set({ effort: valid });
    }
    const settings = get().settings ?? {};
    if (model) {
      const efforts = { ...settings.reasoningEfforts };
      if (valid) efforts[modelKey(model)] = valid;
      else delete efforts[modelKey(model)];
      const next = { ...settings, reasoningEfforts: efforts };
      set({ settings: next });
      void window.cozy.saveSettings(next);
    }
  },

  async applyProviders(providers) {
    set({ providers });
    if (!get().activeId && providers.connected.length) await get().bootstrap();
  },

  async refreshProviders() {
    await get().applyProviders(await window.cozy.providers.list());
  },

  replyPermission(requestId, reply, message, sessionId) {
    const id = sessionId ?? get().activeId;
    if (!id) return;
    // Optimistically drop from the queue; the replied event confirms it (idempotent).
    set((state) => updateView(state, id, (view) => ({
      ...view,
      permissionQueue: view.permissionQueue.filter((request) => request.id !== requestId),
    })));
    void window.cozy.replyPermission({ sessionId: id, requestId, reply, message });
  },

  answerQuestion(requestId, answers, sessionId) {
    const id = sessionId ?? get().activeId;
    if (!id) return;
    set((state) => updateView(state, id, (view) => ({
      ...view,
      questionQueue: view.questionQueue.filter((request) => request.id !== requestId),
    })));
    void window.cozy.replyQuestion({ sessionId: id, requestId, answers });
  },

  rejectQuestion(requestId, sessionId) {
    const id = sessionId ?? get().activeId;
    if (!id) return;
    set((state) => updateView(state, id, (view) => ({
      ...view,
      questionQueue: view.questionQueue.filter((request) => request.id !== requestId),
    })));
    void window.cozy.replyQuestion({ sessionId: id, requestId, answers: null });
  },

  systemNote(text, error) {
    const id = get().activeId;
    if (!id) return;
    set((state) => updateView(state, id, (view) => ({
      ...view,
      items: [
        ...view.items,
        { id: `note-${view.items.length}`, kind: error ? "error" : "system", text },
      ],
    })));
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
