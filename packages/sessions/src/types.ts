export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type AgentMode = "build" | "plan";

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface PermissionRequest {
  id: string;
  sessionId: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { callId: string; toolName: string };
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
}

export interface QuestionRequest {
  id: string;
  sessionId: string;
  questions: QuestionSpec[];
  tool?: { callId: string; toolName: string };
}

/** Local copy of the replay contract until the shared protocol can adopt the archive. */
export type SessionEvent =
  | { type: "session-start"; sessionId: string }
  | { type: "title-change"; title: string }
  | { type: "text-delta"; text: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      metadata?: Record<string, unknown>;
    }
  | { type: "step-finish"; stepNumber: number }
  | { type: "error"; message: string }
  | { type: "mode-change"; mode: AgentMode }
  | { type: "effort-change"; effort?: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "reasoning-end"; id: string; durationMs?: number }
  | { type: "permission-asked"; request: PermissionRequest }
  | { type: "permission-replied"; requestId: string; reply: "once" | "always" | "reject" }
  | { type: "question-asked"; request: QuestionRequest }
  | { type: "question-answered"; requestId: string; answers: string[][] }
  | { type: "question-rejected"; requestId: string }
  | { type: "subagent-start"; toolCallId: string; sessionId: string; agent: string; description: string }
  | { type: "subagent-event"; toolCallId: string; sessionId: string; event: SessionEvent }
  | { type: "subagent-finish"; toolCallId: string; sessionId: string; result: string; isError?: boolean }
  | { type: "session-settled" }
  | { type: "finish"; reason: string; usage?: TokenUsage };

export type ModelMessageRole = "system" | "user" | "assistant" | "tool";
export type ModelHistoryMessage = {
  role: ModelMessageRole;
  content: JsonValue;
} & JsonObject;
export type ModelHistory = ModelHistoryMessage[];

export interface SessionMetadata {
  id: string;
  title: string;
  workspace: string | null;
  model: ModelRef;
  mode: AgentMode;
  effort?: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
}

export interface CreateSessionInput {
  id?: string;
  title?: string;
  workspace: string | null;
  model: ModelRef;
  mode: AgentMode;
  effort?: string;
  createdAt?: number;
  initialHistory?: ModelHistory;
}

export interface SessionUpdate {
  title?: string;
  workspace?: string | null;
  model?: ModelRef;
  mode?: AgentMode;
  /** `null` clears the effort and returns to the provider default. */
  effort?: string | null;
}

export type TurnStatus = "running" | "completed" | "failed" | "aborted" | "interrupted";
export type TerminalTurnStatus = Exclude<TurnStatus, "running" | "interrupted">;

export interface RollbackCheckpoint {
  history: ModelHistory;
  data: JsonValue;
}

export interface SessionTurn {
  id: string;
  sessionID: string;
  ordinal: number;
  prompt: string;
  status: TurnStatus;
  acceptedAt: number;
  settledAt?: number;
  finishReason?: string;
  errorMessage?: string;
  boundarySeq: number;
  checkpoint: RollbackCheckpoint;
}

/** Turn metadata suitable for transcript and timeline hydration without checkpoint history. */
export type SessionTurnSummary = Omit<SessionTurn, "checkpoint">;

export interface AcceptTurnInput {
  sessionID: string;
  turnID?: string;
  prompt: string;
  acceptedAt?: number;
  /** Frontend state to restore alongside the model history when reverting. */
  rollbackData?: JsonValue;
}

export interface SessionEventRecord {
  sessionID: string;
  seq: number;
  at: number;
  turnID?: string;
  event: SessionEvent;
}

export interface AppendEventInput {
  sessionID: string;
  turnID?: string;
  at?: number;
  event: SessionEvent;
}

export interface SettleTurnInput {
  sessionID: string;
  turnID: string;
  status: TerminalTurnStatus;
  settledAt?: number;
  terminalEvent: Extract<SessionEvent, { type: "finish" | "error" }>;
  history: ModelHistory;
  /** Final frontend rollback state, replacing the provisional data captured at acceptance. */
  rollbackData?: JsonValue;
}

export interface SettledTurn {
  turn: SessionTurn;
  event: SessionEventRecord;
}

export interface SessionDraft {
  sessionID: string;
  revision: number;
  text: string;
  createdAt: number;
}

export interface SaveDraftInput {
  sessionID: string;
  text: string;
  createdAt?: number;
  /** Optimistic concurrency guard. Zero means no prior draft. */
  expectedRevision?: number;
}

export interface ForkSessionOptions {
  id?: string;
  title?: string;
  createdAt?: number;
}

export interface RevertBoundary {
  sessionID: string;
  turnID: string;
  turnOrdinal: number;
  eventSeq: number;
  previousTurnID?: string;
  checkpoint: RollbackCheckpoint;
}

export interface RevertMutationOptions {
  updatedAt?: number;
  /** Optimistic guard. Zero represents no active revert cursor. */
  expectedRevision?: number;
}

export interface SessionRevertState {
  sessionID: string;
  revision: number;
  boundaryTurnID: string;
  boundaryOrdinal: number;
  boundarySeq: number;
  visibleTurnCount: number;
  originalTurnCount: number;
  originalHistory: ModelHistory;
  /** Frontend state from the pre-turn checkpoint at the current boundary. */
  rollbackData: JsonValue;
  createdAt: number;
  updatedAt: number;
}

export interface ArchivedSession {
  metadata: SessionMetadata;
  turns: SessionTurn[];
  events: SessionEventRecord[];
  history: ModelHistory;
  draft?: SessionDraft;
}

export interface RecentSessionLoadOptions {
  eventLimit: number;
  turnLimit: number;
}

export interface RecentSessionWindow {
  eventsOmitted: boolean;
  turnsOmitted: boolean;
  firstEventSeq?: number;
  lastEventSeq?: number;
}

/** Bounded presentation snapshot. Complete model history remains available via `getModelHistory`. */
export interface RecentArchivedSession {
  metadata: SessionMetadata;
  turns: SessionTurnSummary[];
  events: SessionEventRecord[];
  draft?: SessionDraft;
  window: RecentSessionWindow;
}

export type SessionReplaySnapshot = ArchivedSession | RecentArchivedSession;

export interface SessionArchive {
  listSessions(): SessionMetadata[];
  getSession(id: string): SessionMetadata | undefined;
  loadSession(id: string): ArchivedSession | undefined;
  loadRecentSession(id: string, options: RecentSessionLoadOptions): RecentArchivedSession | undefined;
  createSession(input: CreateSessionInput): SessionMetadata;
  updateSession(id: string, patch: SessionUpdate, updatedAt?: number): SessionMetadata;
  deleteSession(id: string): boolean;
  listTurns(sessionID: string): SessionTurn[];
  listRecentVisibleTurns(sessionID: string, limit: number): SessionTurnSummary[];
  acceptTurn(input: AcceptTurnInput): SessionTurn;
  appendEvent(input: AppendEventInput): SessionEventRecord;
  listEvents(sessionID: string, afterSeq?: number): SessionEventRecord[];
  listVisibleEvents(sessionID: string, afterSeq?: number): SessionEventRecord[];
  settleTurn(input: SettleTurnInput): SettledTurn;
  getModelHistory(sessionID: string): ModelHistory;
  getDraft(sessionID: string): SessionDraft | undefined;
  listDraftRevisions(sessionID: string): SessionDraft[];
  saveDraft(input: SaveDraftInput): SessionDraft;
  getRollbackCheckpoint(sessionID: string, turnID: string): RollbackCheckpoint;
  updateInterruptedTurnRollback(sessionID: string, turnID: string, rollbackData: JsonValue): SessionTurn;
  recoverInterruptedTurns(at?: number): SessionTurn[];
  forkSession(sourceID: string, options?: ForkSessionOptions): SessionMetadata;
  forkFromTurn(sourceID: string, turnID: string, options?: ForkSessionOptions): SessionMetadata;
  getRevertState(sessionID: string): SessionRevertState | undefined;
  undoToTurn(sessionID: string, turnID: string, options?: RevertMutationOptions): SessionRevertState;
  redoTurn(sessionID: string, options?: RevertMutationOptions): SessionRevertState | undefined;
  commitRevert(sessionID: string, options?: RevertMutationOptions): SessionMetadata;
  getRevertBoundary(sessionID: string, turnID: string): RevertBoundary;
  revertToBoundary(boundary: RevertBoundary, updatedAt?: number): SessionMetadata;
  flush(): void;
  close(): void;
}

export type SessionArchiveErrorCode =
  | "BUSY"
  | "CLOSED"
  | "CORRUPT"
  | "INVALID"
  | "NOT_FOUND"
  | "REVISION_CONFLICT"
  | "UNSUPPORTED_SCHEMA";

export class SessionArchiveError extends Error {
  constructor(
    readonly code: SessionArchiveErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionArchiveError";
  }
}
