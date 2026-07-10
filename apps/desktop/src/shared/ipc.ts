import type {
  AgentMode,
  CustomProviderInput,
  ModelRef,
  OAuthResult,
  OAuthStart,
  PermissionConfig,
  PermissionReplyBody,
  SessionEvent,
  ProviderList,
} from "@cozycode/protocol";

export type {
  CustomProviderInput,
  ModelRef,
  OAuthResult,
  OAuthStart,
  ProviderList,
} from "@cozycode/protocol";

export interface AppSettings {
  workspaceRoot: string;
  permissions?: PermissionConfig;
  /** MRU model refs, newest first. */
  recentModels?: ModelRef[];
  /** Per-model reasoning-effort selections, keyed "providerID/modelID". */
  reasoningEfforts?: Record<string, string>;
  /** Show model context window sizes in the model picker. */
  showContextSize?: boolean;
}

export interface AppSettingsInput extends AppSettings {}

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
  model: ModelRef;
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
  sessionSetEffort: "session:set-effort",
  sessionSetPreset: "session:set-preset",
  permissionReply: "permission:reply",
  // sessions
  sessionsList: "sessions:list",
  sessionsCreate: "sessions:create",
  sessionsActivate: "sessions:activate",
  sessionsDelete: "sessions:delete",
  sessionsRename: "sessions:rename",
  // providers
  providersList: "providers:list",
  providersConnectApi: "providers:connect-api",
  providersAddCustom: "providers:add-custom",
  providersDisconnect: "providers:disconnect",
  providersOauthStart: "providers:oauth-start",
  providersOauthWait: "providers:oauth-wait",
  providersOauthCancel: "providers:oauth-cancel",
  providersOpenExternal: "providers:open-external",
  // terminal
  termCreate: "term:create",
  termInput: "term:input",
  termResize: "term:resize",
  termKill: "term:kill",
  // main -> renderer (push)
  sessionEvent: "session:event",
  sessionsChanged: "sessions:changed",
  providersChanged: "providers:changed",
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
  setModel(ref: ModelRef): Promise<void>;
  setEffort(effort?: string): Promise<void>;
  setPreset(preset: PermissionPreset): Promise<void>;
  replyPermission(body: PermissionReplyBody): Promise<void>;

  // session management
  listSessions(): Promise<SessionMeta[]>;
  createSession(opts?: { workspaceRoot?: string | null }): Promise<SessionSnapshot>;
  activateSession(id: string): Promise<SessionSnapshot>;
  /** Returns the new active snapshot if the active session was deleted, else null. */
  deleteSession(id: string): Promise<SessionSnapshot | null>;
  renameSession(id: string, title: string): Promise<void>;

  providers: {
    list(): Promise<ProviderList>;
    connectApi(providerID: string, apiKey: string): Promise<ProviderList>;
    addCustom(input: CustomProviderInput): Promise<ProviderList>;
    disconnect(providerID: string): Promise<ProviderList>;
    oauthStart(providerID: string, method: number): Promise<OAuthStart>;
    oauthWait(providerID: string, attemptID: string): Promise<OAuthResult>;
    oauthCancel(providerID: string, attemptID: string): Promise<void>;
    openExternal(url: string): Promise<void>;
    onChanged(cb: (list: ProviderList) => void): () => void;
  };

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
