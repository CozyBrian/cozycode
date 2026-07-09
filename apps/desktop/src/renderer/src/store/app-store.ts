import { create } from "zustand";
import type {
  AgentMode,
  ApprovalOutcome,
  ApprovalRequest,
  SessionEvent,
} from "@cozycode/protocol";
import type {
  AppSettings,
  PermissionPreset,
  SessionMeta,
  SessionRecord,
} from "../../../shared/ipc.ts";
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
  terminalOpen: boolean;
  terminalHeight: number;
  settingsOpen: boolean;
  helpOpen: boolean;

  // sessions
  sessions: SessionMeta[];
  activeId: string | null;

  // active chat
  items: TranscriptItem[];
  busy: boolean;
  preset: PermissionPreset;
  model: string;
  models: string[];
  approval: ApprovalRequest | null;
  input: string;

  // terminals
  termTabs: TermTab[];
  activeTermId: string | null;

  // --- actions ---
  bootstrap(): Promise<void>;
  applyEvent(event: SessionEvent): void;

  toggleSidebar(): void;
  toggleTerminal(): void;
  setTerminalHeight(px: number): void;
  openSettings(): void;
  closeSettings(): void;
  setHelpOpen(open: boolean): void;
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
  setModel(model: string): void;
  refreshModels(): Promise<void>;
  respondApproval(outcome: ApprovalOutcome): void;
  systemNote(text: string, error?: boolean): void;

  newTerminal(): Promise<void>;
  registerTerm(id: string): void;
  closeTerm(id: string): void;
  setActiveTerm(id: string): void;
}

const presetToMode = (p: PermissionPreset): AgentMode => (p === "plan" ? "plan" : "build");

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
  terminalOpen: false,
  terminalHeight: 260,
  settingsOpen: false,
  helpOpen: false,

  sessions: [],
  activeId: null,

  items: [],
  busy: false,
  preset: "ask",
  model: "",
  models: [],
  approval: null,
  input: "",

  termTabs: [],
  activeTermId: null,

  async bootstrap() {
    const settings = await window.cozy.getSettings();
    const configured = Boolean(settings?.baseURL && settings?.model && settings?.workspaceRoot);
    set({ settings, loaded: true, settingsOpen: !configured });
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
        busy: false,
      });
      void get().refreshSessions();
      void get().refreshModels();
    }
  },

  applyEvent(event) {
    set((s) => ({ items: foldEvent(s.items, event) }));
    if (event.type === "mode-change") {
      // Keep the pill honest if the mode changed underneath us.
      set((s) => ({ preset: event.mode === "plan" ? "plan" : s.preset === "plan" ? "ask" : s.preset }));
    }
    if (event.type === "finish" || event.type === "error") set({ busy: false });
  },

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setTerminalHeight: (px) => set({ terminalHeight: Math.max(120, Math.min(600, px)) }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  setHelpOpen: (open) => set({ helpOpen: open }),
  setInput: (v) => set({ input: v }),
  setSettings: (s) => set({ settings: s }),

  async refreshSessions() {
    set({ sessions: await window.cozy.listSessions() });
  },

  async createSession(workspaceRoot) {
    const snap = await window.cozy.createSession(
      workspaceRoot !== undefined ? { workspaceRoot } : undefined,
    );
    set({
      activeId: snap.meta.id,
      items: replayRecords(snap.records),
      preset: snap.meta.preset,
      model: snap.meta.model,
      busy: false,
      input: "",
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
      busy: false,
      input: "",
    });
    void get().refreshModels();
  },

  async deleteSession(id) {
    const snap = await window.cozy.deleteSession(id);
    if (snap) {
      set({
        activeId: snap.meta.id,
        items: replayRecords(snap.records),
        preset: snap.meta.preset,
        model: snap.meta.model,
        busy: false,
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
    set({ model });
    void window.cozy.setModel(model);
  },

  async refreshModels() {
    set({ models: await window.cozy.listModels() });
  },

  respondApproval(outcome) {
    const { approval } = get();
    if (approval) window.cozy.respondApproval(approval.requestId, outcome);
    set({ approval: null });
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
