import type {
  AgentMode,
  CustomProviderInput,
  ModelRef,
  OAuthResult,
  OAuthStart,
  PermissionConfig,
  PermissionReplyBody,
  PermissionRequest,
  QuestionReplyBody,
  QuestionRequest,
  SessionEvent,
  ProviderList,
} from "@cozycode/protocol";
import { DESKTOP_COMMANDS, type DesktopCommandId, type ShortcutOverrides } from "./desktop-commands.ts";

export type {
  CustomProviderInput,
  ModelRef,
  OAuthResult,
  OAuthStart,
  ProviderList,
  QuestionRequest,
  QuestionReplyBody,
} from "@cozycode/protocol";

export interface AppSettings {
  /** Last-used workspace; the global New chat action uses this root. */
  workspaceRoot?: string;
  /** Ordered project roots displayed in the sidebar. */
  openWorkspaceRoots?: string[];
  permissions?: PermissionConfig;
  /** MRU model refs, newest first. */
  recentModels?: ModelRef[];
  /** Per-model reasoning-effort selections, keyed "providerID/modelID". */
  reasoningEfforts?: Record<string, string>;
  /** Show model context window sizes in the model picker. */
  showContextSize?: boolean;
  /** Initial central view after launch. */
  startupView?: "empty" | "continue-last-session";
  /** Start with every project group collapsed. Defaults to true. */
  collapseProjectGroupsOnStartup?: boolean;
  /** Most recently expanded or collapsed project; global New chat targets it. */
  lastToggledWorkspaceRoot?: string;
  /** User overrides for application-wide native menu shortcuts. */
  shortcutOverrides?: ShortcutOverrides;
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
  /** Set → this is a subagent (child) session, grouped under its parent. */
  parentID?: string | null;
  /** The subagent type that produced this child session (for labeling). */
  agent?: string;
}

/**
 * One line of a session's append-only replay log. `user` records carry the
 * user's message (not part of SessionEvent); `event` records wrap the core's
 * stream. The renderer folds these into a transcript on activation.
 */
export type SessionRecord =
  | { at: number; kind: "user"; text: string; turnId: string }
  | { at: number; kind: "event"; event: SessionEvent };

export interface EditTurnRequest {
  sessionId: string;
  turnId: string;
  replacementTurnId: string;
  text: string;
}

export interface WorkspaceReferenceSuggestion {
  path: string;
  directory: boolean;
}

export interface SessionOperationResult {
  ok: boolean;
  error?: string;
  warnings?: string[];
}

/** Result of activating/creating a session: metadata + transcript to replay. */
export interface SessionSnapshot {
  meta: SessionMeta;
  records: SessionRecord[];
  running: boolean;
  permissionQueue: PermissionRequest[];
  questionQueue: QuestionRequest[];
}

/** A core event tagged with the top-level session that owns it. */
export interface SessionEventEnvelope {
  sessionId: string;
  event: SessionEvent;
}

export interface AddressedPermissionReply extends PermissionReplyBody {
  sessionId: string;
}

export interface AddressedQuestionReply extends QuestionReplyBody {
  sessionId: string;
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

/** One changed path in the active workspace's git working tree. */
export interface GitFileStatus {
  /** Repo-relative path (for renames, the current path). */
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
  /** Has changes in the index (staged). */
  staged: boolean;
  /** Has changes in the working tree (unstaged / untracked). */
  unstaged: boolean;
  additions: number;
  deletions: number;
}

/** Snapshot of the active workspace's git status. */
export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

/** IPC channel names, centralized so main/preload/renderer agree. */
export const IPC = {
  settingsGet: "settings:get",
  settingsSave: "settings:save",
  appQuit: "app:quit",
  pickWorkspace: "dialog:pick-workspace",
  sessionSend: "session:send",
  sessionShell: "session:shell",
  sessionReferenceSearch: "session:reference-search",
  sessionAbort: "session:abort",
  sessionSetMode: "session:set-mode",
  sessionSetModel: "session:set-model",
  sessionSetEffort: "session:set-effort",
  sessionSetPreset: "session:set-preset",
  permissionReply: "permission:reply",
  questionReply: "question:reply",
  // sessions
  sessionsList: "sessions:list",
  sessionsCreate: "sessions:create",
  sessionsActivate: "sessions:activate",
  sessionsDelete: "sessions:delete",
  sessionsRename: "sessions:rename",
  sessionsExport: "sessions:export",
  sessionsFork: "sessions:fork",
  sessionsForkTurn: "sessions:fork-turn",
  sessionsEditTurn: "sessions:edit-turn",
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
  // git
  gitStatus: "git:status",
  gitDiff: "git:diff",
  // main -> renderer (push)
  sessionEvent: "session:event",
  sessionsChanged: "sessions:changed",
  providersChanged: "providers:changed",
  termData: "term:data",
  termExit: "term:exit",
  gitChanged: "git:changed",
  nativeCommand: "native:command",
  dockBadge: "native:dock-badge",
} as const;

export type NativeCommand = DesktopCommandId;
export const NATIVE_COMMANDS: readonly NativeCommand[] = DESKTOP_COMMANDS.map((command) => command.id);

export function isNativeCommand(value: unknown): value is NativeCommand {
  return typeof value === "string" && (NATIVE_COMMANDS as readonly string[]).includes(value);
}

/** The typed API exposed on `window.cozy` by the preload script. */
export interface CozyApi {
  readonly platform: string;
  getSettings(): Promise<AppSettings | null>;
  saveSettings(input: AppSettingsInput): Promise<AppSettings>;
  quit(): Promise<void>;
  pickWorkspace(): Promise<string | null>;

  // session-addressed actions
  send(sessionId: string, message: string, turnId: string): Promise<SessionOperationResult>;
  shell(sessionId: string, command: string, turnId: string): Promise<SessionOperationResult>;
  searchWorkspaceReferences(sessionId: string, query: string): Promise<WorkspaceReferenceSuggestion[]>;
  abort(sessionId: string): Promise<void>;
  setMode(sessionId: string, mode: AgentMode): Promise<void>;
  setModel(sessionId: string, ref: ModelRef): Promise<void>;
  setEffort(sessionId: string, effort?: string): Promise<void>;
  setPreset(sessionId: string, preset: PermissionPreset): Promise<void>;
  replyPermission(body: AddressedPermissionReply): Promise<void>;
  replyQuestion(body: AddressedQuestionReply): Promise<void>;

  // session management
  listSessions(): Promise<SessionMeta[]>;
  createSession(opts?: { workspaceRoot?: string | null }): Promise<SessionSnapshot>;
  activateSession(id: string): Promise<SessionSnapshot>;
  /** Deletes a session; deleting the active session leaves no session selected. */
  deleteSession(id: string): Promise<SessionSnapshot | null>;
  renameSession(id: string, title: string): Promise<void>;
  /** Opens a Save As dialog and exports the selected session as Markdown. */
  exportSession(id: string): Promise<string | null>;
  forkSession(id: string): Promise<SessionSnapshot>;
  forkFromTurn(sessionId: string, turnId: string): Promise<SessionSnapshot>;
  editTurn(request: EditTurnRequest): Promise<{ ok: boolean; error?: string }>;

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

  // git (read-only view of the active workspace)
  git: {
    status(): Promise<GitStatus>;
    /** Unified diff for one path; `staged` selects the index vs working-tree diff. */
    diff(path: string, staged: boolean): Promise<string>;
    onChanged(cb: (status: GitStatus) => void): () => void;
  };

  // push streams (permission-asked / permission-replied arrive via onEvent)
  onEvent(cb: (envelope: SessionEventEnvelope) => void): () => void;
  onSessionsChanged(cb: (sessions: SessionMeta[]) => void): () => void;
  onNativeCommand(cb: (command: NativeCommand) => void): () => void;
  setDockBadge(count: number): void;
}

declare global {
  interface Window {
    cozy: CozyApi;
  }
}
