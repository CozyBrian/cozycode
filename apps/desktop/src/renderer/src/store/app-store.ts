import { create } from "zustand";
import type {
  AgentMode,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  ProviderList,
  SessionEvent,
} from "@cozycode/protocol";
import type {
  AppSettings,
  PermissionPreset,
  SessionMeta,
  SessionRecord,
} from "../../../shared/ipc.ts";
import { effortsForModel, modelKey, resolveEffort } from "@cozycode/commands";
import { foldEvent, userItem, type TranscriptItem } from "../transcript.ts";

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
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  helpOpen: boolean;
  modelPickerOpen: boolean;
  effortPickerOpen: boolean;

  // sessions
  sessions: SessionMeta[];
  activeId: string | null;

  // active chat
  items: TranscriptItem[];
  busy: boolean;
  preset: PermissionPreset;
  model: ModelRef | null;
  /** Reasoning effort for the current model (undefined = provider default). */
  effort: string | undefined;
  providers: ProviderList | null;
  recentModels: ModelRef[];
  /** FIFO of pending permission asks; the modal shows the head, badge shows length. */
  permissionQueue: PermissionRequest[];
  input: string;

  // terminals
  termTabs: TermTab[];
  activeTermId: string | null;

  // --- actions ---
  bootstrap(): Promise<void>;
  applyEvent(event: SessionEvent): void;

  toggleSidebar(): void;
  setSidebarWidth(px: number): void;
  toggleTerminal(): void;
  toggleContentPanel(): void;
  setTerminalHeight(px: number): void;
  setContentPanelWidth(px: number): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  setHelpOpen(open: boolean): void;
  setModelPickerOpen(open: boolean): void;
  setEffortPickerOpen(open: boolean): void;
  setInput(v: string): void;
  setSettings(s: AppSettings): void;

  refreshSessions(): Promise<void>;
  createSession(workspaceRoot?: string | null): Promise<void>;
  activateSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;

  send(text: string): Promise<void>;
  abort(): void;
  setPreset(preset: PermissionPreset): void;
  setMode(mode: AgentMode): void;
  setModel(model: ModelRef): void;
  /** Set the reasoning effort for the current model (undefined clears to default). */
  setEffort(effort: string | undefined): void;
  refreshProviders(): Promise<void>;
  replyPermission(requestId: string, reply: PermissionReply, message?: string): void;
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

export const useApp = create<AppState>((set, get) => ({
  settings: null,
  loaded: false,

  sidebarOpen: true,
  sidebarWidth: 290,
  terminalOpen: false,
  terminalHeight: 260,
  contentPanelOpen: false,
  contentPanelWidth: 320,
  settingsOpen: false,
  settingsSection: "general",
  helpOpen: false,
  modelPickerOpen: false,
  effortPickerOpen: false,

  sessions: [],
  activeId: null,

  items: [],
  busy: false,
  preset: "ask",
  model: null,
  effort: undefined,
  providers: null,
  recentModels: [],
  permissionQueue: [],
  input: "",

  termTabs: [],
  activeTermId: null,

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
        preset: snap.meta.preset,
        model: snap.meta.model,
        effort: storedEffort(get(), snap.meta.model),
        busy: false,
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
    if (event.type === "effort-change") set({ effort: event.effort });
    if (event.type === "finish" || event.type === "error") set({ busy: false });
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarWidth: (px) => set({ sidebarWidth: Math.max(200, Math.min(450, px)) }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  toggleContentPanel: () => set((s) => ({ contentPanelOpen: !s.contentPanelOpen })),
  setTerminalHeight: (px) => set({ terminalHeight: Math.max(120, Math.min(600, px)) }),
  setContentPanelWidth: (px) => set({ contentPanelWidth: Math.max(200, Math.min(600, px)) }),
  openSettings: (section = "general") => set({ settingsOpen: true, settingsSection: section }),
  closeSettings: () => set({ settingsOpen: false }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
  setEffortPickerOpen: (open) => set({ effortPickerOpen: open }),
  setInput: (v) => set({ input: v }),
  setSettings: (s) => set({ settings: s }),

  async refreshSessions() {
    set({ sessions: await window.cozy.listSessions() });
  },

  async createSession(workspaceRoot) {
    const empty = get().sessions.find((s) => s.messageCount === 0);
    if (empty) {
      if (empty.id !== get().activeId) await get().activateSession(empty.id);
      return;
    }

    const snap = await window.cozy.createSession(
      workspaceRoot !== undefined ? { workspaceRoot } : undefined,
    );
    set({
      activeId: snap.meta.id,
      items: replayRecords(snap.records),
      preset: snap.meta.preset,
      model: snap.meta.model,
      effort: storedEffort(get(), snap.meta.model),
      busy: false,
      input: "",
      permissionQueue: [],
    });
    await get().refreshSessions();
  },

  async activateSession(id) {
    if (id === get().activeId) return;
    const snap = await window.cozy.activateSession(id);
    set({
      activeId: snap.meta.id,
      items: replayRecords(snap.records),
      preset: snap.meta.preset,
      model: snap.meta.model,
      effort: storedEffort(get(), snap.meta.model),
      busy: false,
      input: "",
      permissionQueue: [],
    });
  },

  async deleteSession(id) {
    const snap = await window.cozy.deleteSession(id);
    if (snap) {
      set({
        activeId: snap.meta.id,
        items: replayRecords(snap.records),
        preset: snap.meta.preset,
        model: snap.meta.model,
        effort: storedEffort(get(), snap.meta.model),
        busy: false,
        permissionQueue: [],
      });
    }
    await get().refreshSessions();
  },

  async renameSession(id, title) {
    await window.cozy.renameSession(id, title);
    await get().refreshSessions();
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

  abort: () => void window.cozy.abort(),

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
