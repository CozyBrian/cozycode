import type {
  AgentMode,
  PermissionConfig,
  PermissionReplyBody,
  SessionEvent,
} from "@cozycode/protocol";

/** Persisted app settings. The API key is stored separately (encrypted). */
export interface AppSettings {
  providerName: string;
  baseURL: string;
  /** Default model for new sessions (each session stores its own thereafter). */
  model: string;
  /** Default workspace for new sessions. */
  workspaceRoot: string;
  /** Optional permission-rule overrides, merged over the preset's ruleset. */
  permissions?: PermissionConfig;
  /** True when an API key is stored (the key itself is never sent to the UI). */
  hasApiKey: boolean;
}

/** Settings payload the renderer sends when saving (may include a new key). */
export interface AppSettingsInput extends Omit<AppSettings, "hasApiKey"> {
  apiKey?: string;
}

/** Permission preset shown as a pill in the composer. */
export type PermissionPreset = "full" | "ask" | "plan";

/** Metadata for one persisted session, used to render the sidebar list. */
export interface SessionMeta {
  id: string;
  title: string;
  /** Once the user renames a session, stop auto-updating its title. */
  titleEdited: boolean;
  createdAt: number;
  updatedAt: number;
  /** null → a standalone chat (grouped under "Chats"); set → grouped by project. */
  workspaceRoot: string | null;
  model: string;
  preset: PermissionPreset;
  /** Number of user turns. */
  messageCount: number;
}

/**
 * One line of a session's append-only replay log. `user` records carry the
 * user's message (not part of SessionEvent); `event` records wrap the core's
 * stream. The renderer folds these into a transcript on activation.
 */
export type SessionRecord =
  | { at: number; kind: "user"; text: string }
  | { at: number; kind: "event"; event: SessionEvent };

/** Result of activating/creating a session: metadata + transcript to replay. */
export interface SessionSnapshot {
  meta: SessionMeta;
  records: SessionRecord[];
}

/** Push payload for terminal output. */
export interface TermData {
  termId: string;
  data: string;
}

/** Push payload when a terminal's shell exits. */
export interface TermExit {
  termId: string;
  exitCode: number;
}

/** IPC channel names, centralized so main/preload/renderer agree. */
export const IPC = {
  settingsGet: "settings:get",
  settingsSave: "settings:save",
  pickWorkspace: "dialog:pick-workspace",
  sessionSend: "session:send",
  sessionAbort: "session:abort",
  sessionSetMode: "session:set-mode",
  sessionSetModel: "session:set-model",
  sessionSetPreset: "session:set-preset",
  permissionReply: "permission:reply",
  // sessions
  sessionsList: "sessions:list",
  sessionsCreate: "sessions:create",
  sessionsActivate: "sessions:activate",
  sessionsDelete: "sessions:delete",
  sessionsRename: "sessions:rename",
  // models
  modelsList: "models:list",
  // terminal
  termCreate: "term:create",
  termInput: "term:input",
  termResize: "term:resize",
  termKill: "term:kill",
  // main -> renderer (push)
  sessionEvent: "session:event",
  sessionsChanged: "sessions:changed",
  termData: "term:data",
  termExit: "term:exit",
} as const;

/** The typed API exposed on `window.cozy` by the preload script. */
export interface CozyApi {
  getSettings(): Promise<AppSettings | null>;
  saveSettings(input: AppSettingsInput): Promise<AppSettings>;
  pickWorkspace(): Promise<string | null>;

  // active-session actions
  send(message: string): Promise<{ ok: boolean; error?: string }>;
  abort(): Promise<void>;
  setMode(mode: AgentMode): Promise<void>;
  setModel(model: string): Promise<void>;
  setPreset(preset: PermissionPreset): Promise<void>;
  replyPermission(body: PermissionReplyBody): Promise<void>;

  // session management
  listSessions(): Promise<SessionMeta[]>;
  createSession(opts?: { workspaceRoot?: string | null }): Promise<SessionSnapshot>;
  activateSession(id: string): Promise<SessionSnapshot>;
  /** Returns the new active snapshot if the active session was deleted, else null. */
  deleteSession(id: string): Promise<SessionSnapshot | null>;
  renameSession(id: string, title: string): Promise<void>;

  // models
  listModels(): Promise<string[]>;

  // terminal
  term: {
    create(opts: { cols: number; rows: number }): Promise<{ termId: string }>;
    write(termId: string, data: string): Promise<void>;
    resize(termId: string, cols: number, rows: number): Promise<void>;
    kill(termId: string): Promise<void>;
    onData(cb: (payload: TermData) => void): () => void;
    onExit(cb: (payload: TermExit) => void): () => void;
  };

  // push streams (permission-asked / permission-replied arrive via onEvent)
  onEvent(cb: (event: SessionEvent) => void): () => void;
  onSessionsChanged(cb: (sessions: SessionMeta[]) => void): () => void;
}

declare global {
  interface Window {
    cozy: CozyApi;
  }
}
