import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  execShell,
  openWorkspaceSnapshotEngine,
  type ModelMessage,
  type OpenWorkspaceSnapshotResult,
  type ShellResult,
  type SnapshotOmission,
  type WorkspaceCheckpoint,
  type WorkspaceSnapshot,
  type WorkspaceSnapshotEngine,
  type WorkspaceSnapshotOptions,
} from "@cozycode/core";
import type {
  AgentMode,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  QuestionRequest,
  SessionEvent,
} from "@cozycode/protocol";
import type {
  ArchivedSession,
  CreateSessionInput,
  ForkSessionOptions,
  JsonValue,
  ModelHistory,
  RecentArchivedSession,
  RecentSessionLoadOptions,
  RevertMutationOptions,
  SessionArchive,
  SessionEventRecord,
  SessionMetadata,
  SessionRevertState,
  SessionTurn,
  SessionTurnSummary,
  SessionUpdate,
  SettledTurn,
} from "@cozycode/sessions";

export interface TuiSessionLike {
  readonly id: string;
  readonly events: AsyncIterable<SessionEvent>;
  send(message: string): Promise<void>;
  snapshotHistory(): ModelMessage[];
  abort(): void;
  close(): void | Promise<void>;
  pendingPermissions?(): PermissionRequest[];
  pendingQuestions?(): QuestionRequest[];
  replyPermission?(requestID: string, reply: PermissionReply, message?: string): void;
  answerQuestion?(requestID: string, answers: string[][]): void;
  rejectQuestion?(requestID: string, message?: string): void;
  setModel?(modelID: string): void;
  setMode?(mode: AgentMode): void;
  setReasoningEffort?(effort: string | undefined): void;
}

export interface TuiRuntimeFactoryContext {
  metadata: SessionMetadata;
  initialHistory: ModelMessage[];
  signal: AbortSignal;
}

export type TuiRuntimeFactory = (
  context: TuiRuntimeFactoryContext,
) => TuiSessionLike | Promise<TuiSessionLike>;

export type TuiShellExecutor = (
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<ShellResult>;

export type TuiSessionStatus = "queued" | "running" | "waiting" | "settling" | "idle" | "error";

export interface AddressedTuiSessionEvent {
  type: "session-event";
  sessionID: string;
  turnID?: string;
  event: SessionEvent;
  record: SessionEventRecord;
}

export interface AddressedTuiStatusEvent {
  type: "status";
  sessionID: string;
  turnID?: string;
  status: TuiSessionStatus;
  at: number;
  error?: string;
}

export type TuiSessionHostEvent = AddressedTuiSessionEvent | AddressedTuiStatusEvent;
export type TuiSessionHostListener = (event: TuiSessionHostEvent) => void;

export interface TuiRollbackCoverage {
  scope: "workspace-files" | "none";
  changedPaths: string[];
  omissions: Array<SnapshotOmission & { phase: "before" | "after" }>;
}

export type TuiFilesystemRollback =
  | {
      status: "pending";
      workspace: string;
      before: WorkspaceSnapshot;
      coverage: TuiRollbackCoverage;
      warnings: string[];
    }
  | {
      status: "ready";
      workspace: string;
      checkpoint: WorkspaceCheckpoint;
      coverage: TuiRollbackCoverage;
      warnings: string[];
    }
  | {
      status: "unavailable";
      workspace: string | null;
      phase: "not-applicable" | "open" | "before" | "after" | "checkpoint";
      reason: string;
      detail?: string;
      paths: string[];
      coverage: TuiRollbackCoverage;
      warnings: string[];
    };

export interface TuiRollbackPayload {
  version: 1;
  filesystem: TuiFilesystemRollback;
}

export type TuiSessionHostErrorCode =
  | "BUSY"
  | "CLOSED"
  | "NOT_FOUND"
  | "READ_ONLY"
  | "ROLLBACK_CONFLICT"
  | "ROLLBACK_FAILED"
  | "ROLLBACK_UNAVAILABLE";

export class TuiSessionHostError extends Error {
  constructor(
    readonly code: TuiSessionHostErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TuiSessionHostError";
  }
}

type SnapshotOpener = (
  directory: string,
  options?: WorkspaceSnapshotOptions,
) => Promise<OpenWorkspaceSnapshotResult>;

export interface TuiSessionHostOptions {
  archive: SessionArchive;
  runtimeFactory: TuiRuntimeFactory;
  shellExecutor?: TuiShellExecutor;
  openSnapshotEngine?: SnapshotOpener;
  snapshotOptions?: WorkspaceSnapshotOptions;
  /** Maximum settled, interaction-free runtimes retained for reuse. */
  maxIdleRuntimes?: number;
  /** Maximum delay before adjacent stream deltas are persisted and published. */
  deltaCoalesceIntervalMs?: number;
  now?: () => number;
  onListenerError?: (error: unknown) => void;
}

export interface TuiSendOptions {
  turnID?: string;
  displayPrompt?: string;
}

export interface TuiShellOptions {
  turnID?: string;
  timeoutMs?: number;
}

interface RuntimeEntry {
  session: TuiSessionLike;
  metadata: SessionMetadata;
  pump: Promise<void>;
  active?: TurnOperation;
  closing?: Promise<void>;
  lastUsed: number;
  pendingDelta?: PendingDelta;
  pendingPermissions: Map<string, PermissionRequest>;
  pendingQuestions: Map<string, QuestionRequest>;
}

interface TurnOperation {
  kind: "model" | "shell";
  sessionID: string;
  turnID: string;
  prompt: string;
  archivePrompt: string;
  timeoutMs?: number;
  controller: AbortController;
  abortRequested: boolean;
  runtime?: RuntimeEntry;
  terminal?: Extract<SessionEvent, { type: "finish" | "error" }>;
  eventPumpBarrier?: EventPumpBarrier;
  eventError?: Error;
  accepted?: SessionTurn;
  promise?: Promise<SessionTurn>;
}

interface EventPumpBarrier {
  promise: Promise<void>;
  release: () => void;
}

interface PendingDelta {
  event: SessionEvent;
  at: number;
  turnID?: string;
  operation?: TurnOperation;
  timer: ReturnType<typeof setTimeout>;
}

interface BuildSnapshotState {
  workspace: string | null;
  key: string;
  engine?: WorkspaceSnapshotEngine;
  openFailure?: Extract<OpenWorkspaceSnapshotResult, { status: "unsupported" }> | {
    status: "unsupported";
    reason: "snapshot-open-failed";
    detail: string;
  };
  before?: Awaited<ReturnType<WorkspaceSnapshotEngine["capture"]>>;
}

const ROLLBACK_WARNINGS = [
  "Rollback covers only eligible files represented by the workspace checkpoint.",
  "Shell state and external side effects, including processes, network operations, and changes outside the workspace, are not restored.",
] as const;

const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const DEFAULT_TUI_DELTA_COALESCE_INTERVAL_MS = 16;
export const DEFAULT_TUI_MAX_IDLE_RUNTIMES = 8;

/** Durable, session-addressed owner of core runtimes for the TUI. */
export class TuiSessionHost {
  private readonly archive: SessionArchive;
  private readonly runtimeFactory: TuiRuntimeFactory;
  private readonly shellExecutor: TuiShellExecutor;
  private readonly openSnapshotEngine: SnapshotOpener;
  private readonly snapshotOptions: WorkspaceSnapshotOptions | undefined;
  private readonly maxIdleRuntimes: number;
  private readonly deltaCoalesceIntervalMs: number;
  private readonly now: () => number;
  private readonly onListenerError: (error: unknown) => void;
  private readonly listeners = new Set<TuiSessionHostListener>();
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly runtimeCreations = new Map<string, Promise<RuntimeEntry>>();
  private readonly turns = new Map<string, TurnOperation>();
  private readonly statuses = new Map<string, TuiSessionStatus>();
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly workspaceTails = new Map<string, Promise<void>>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly reverseCheckpoints = new Map<string, WorkspaceCheckpoint>();
  private closePromise?: Promise<void>;
  private closing = false;
  private runtimeUseSequence = 0;

  constructor(options: TuiSessionHostOptions) {
    this.archive = options.archive;
    this.runtimeFactory = options.runtimeFactory;
    this.shellExecutor = options.shellExecutor ?? execShell;
    this.openSnapshotEngine = options.openSnapshotEngine ?? openWorkspaceSnapshotEngine;
    this.snapshotOptions = options.snapshotOptions;
    this.maxIdleRuntimes = options.maxIdleRuntimes ?? DEFAULT_TUI_MAX_IDLE_RUNTIMES;
    this.deltaCoalesceIntervalMs = options.deltaCoalesceIntervalMs
      ?? DEFAULT_TUI_DELTA_COALESCE_INTERVAL_MS;
    assertNonNegativeSafeInteger(this.maxIdleRuntimes, "maxIdleRuntimes");
    assertNonNegativeSafeInteger(this.deltaCoalesceIntervalMs, "deltaCoalesceIntervalMs");
    this.now = options.now ?? Date.now;
    this.onListenerError = options.onListenerError ?? ((error) => console.error("TUI session listener failed", error));
  }

  subscribe(listener: TuiSessionHostListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(sessionID: string): TuiSessionStatus {
    return this.getLiveStatus(sessionID) ?? "idle";
  }

  getLiveStatus(sessionID: string): TuiSessionStatus | undefined {
    return this.statuses.get(sessionID);
  }

  createSession(input: CreateSessionInput): SessionMetadata {
    this.assertOpen();
    const metadata = this.archive.createSession(input);
    this.statuses.set(metadata.id, "idle");
    return metadata;
  }

  listSessions(): SessionMetadata[] {
    this.assertOpen();
    return this.archive.listSessions();
  }

  loadSession(sessionID: string): ArchivedSession | undefined {
    this.assertOpen();
    return this.archive.loadSession(sessionID);
  }

  loadRecentSession(
    sessionID: string,
    options: RecentSessionLoadOptions,
  ): RecentArchivedSession | undefined {
    this.assertOpen();
    return this.archive.loadRecentSession(sessionID, options);
  }

  listRecentVisibleTurns(sessionID: string, limit: number): SessionTurnSummary[] {
    this.assertOpen();
    return this.archive.listRecentVisibleTurns(sessionID, limit);
  }

  recoverPendingRollbacks(): Promise<Error[]> {
    this.assertOpen();
    return this.track((async () => {
      const errors: Error[] = [];
      for (const metadata of this.archive.listSessions()) {
        for (const turn of this.archive.listTurns(metadata.id)) {
          const pending = turn.status === "interrupted"
            ? pendingRollback(turn.checkpoint.data)
            : undefined;
          if (!pending) continue;
          try {
            await this.enqueueMutation(metadata.id, () => this.recoverPendingRollback(
              metadata,
              turn,
              pending,
            ));
          } catch (error) {
            errors.push(asError(error));
          }
        }
      }
      return errors;
    })());
  }

  updateSession(sessionID: string, patch: SessionUpdate): Promise<SessionMetadata> {
    this.assertOpen();
    this.requireMetadata(sessionID);
    return this.track(this.enqueueMutation(sessionID, async () => {
      const previous = this.requireMetadata(sessionID);
      const updated = this.archive.updateSession(sessionID, patch, this.timestamp());
      const runtime = this.runtimes.get(sessionID);
      if (!runtime) return updated;

      if (!this.canMutateRuntime(runtime, previous, updated, patch)) {
        await this.closeRuntime(sessionID, runtime);
        return updated;
      }

      try {
        if (patch.model) runtime.session.setModel!(patch.model.modelID);
        if (patch.mode) runtime.session.setMode!(patch.mode);
        if (Object.hasOwn(patch, "effort")) {
          runtime.session.setReasoningEffort!(patch.effort ?? undefined);
        }
        runtime.metadata = updated;
        this.touchRuntime(runtime);
      } catch {
        await this.closeRuntime(sessionID, runtime);
      }
      return updated;
    }));
  }

  setModel(sessionID: string, model: ModelRef): Promise<SessionMetadata> {
    return this.updateSession(sessionID, { model });
  }

  setMode(sessionID: string, mode: AgentMode): Promise<SessionMetadata> {
    return this.updateSession(sessionID, { mode });
  }

  setEffort(sessionID: string, effort: string | undefined): Promise<SessionMetadata> {
    return this.updateSession(sessionID, { effort: effort ?? null });
  }

  deleteSession(sessionID: string): Promise<boolean> {
    this.assertOpen();
    this.requireMetadata(sessionID);
    this.abort(sessionID);
    return this.track(this.enqueueMutation(sessionID, async () => {
      const runtime = this.runtimes.get(sessionID);
      if (runtime) await this.closeRuntime(sessionID, runtime);
      this.statuses.delete(sessionID);
      this.reverseCheckpoints.delete(sessionID);
      return this.archive.deleteSession(sessionID);
    }));
  }

  forkSession(sourceID: string, options?: ForkSessionOptions): Promise<SessionMetadata> {
    return this.fork(sourceID, undefined, options);
  }

  forkFromTurn(
    sourceID: string,
    turnID: string,
    options?: ForkSessionOptions,
  ): Promise<SessionMetadata> {
    return this.fork(sourceID, turnID, options);
  }

  send(sessionID: string, prompt: string, options: TuiSendOptions = {}): Promise<SessionTurn> {
    try {
      this.assertOpen();
      this.requireMetadata(sessionID);
      if (!prompt.trim()) throw new Error("The message cannot be empty.");
      if (options.displayPrompt !== undefined && !options.displayPrompt.trim()) {
        throw new Error("The display message cannot be empty.");
      }
      this.assertTurnAvailable(sessionID);
    } catch (error) {
      return Promise.reject(error);
    }

    const operation: TurnOperation = {
      kind: "model",
      sessionID,
      turnID: options.turnID ?? randomUUID(),
      prompt,
      archivePrompt: options.displayPrompt ?? prompt,
      controller: new AbortController(),
      abortRequested: false,
    };
    return this.enqueueTurn(operation);
  }

  shell(sessionID: string, command: string, options: TuiShellOptions = {}): Promise<SessionTurn> {
    let executable = command;
    let archivePrompt = command;
    try {
      this.assertOpen();
      this.requireMetadata(sessionID);
      if (command.startsWith("!")) executable = command.slice(1).trimStart();
      else archivePrompt = `!${command}`;
      if (!executable.trim()) throw new Error("The shell command cannot be empty.");
      if (
        options.timeoutMs !== undefined
        && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
      ) {
        throw new Error("The shell timeout must be a positive integer.");
      }
      this.assertTurnAvailable(sessionID);
    } catch (error) {
      return Promise.reject(error);
    }

    const operation: TurnOperation = {
      kind: "shell",
      sessionID,
      turnID: options.turnID ?? randomUUID(),
      prompt: executable,
      archivePrompt,
      timeoutMs: options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
      controller: new AbortController(),
      abortRequested: false,
    };
    return this.enqueueTurn(operation);
  }

  private enqueueTurn(operation: TurnOperation): Promise<SessionTurn> {
    const { sessionID } = operation;
    this.turns.set(sessionID, operation);
    this.publishStatus(operation, "queued");
    const queued = this.enqueueMutation(
      sessionID,
      () => operation.kind === "shell" ? this.runShellTurn(operation) : this.runModelTurn(operation),
    );
    const promise = this.track(queued.finally(async () => {
      if (this.turns.get(sessionID) === operation) this.turns.delete(sessionID);
      try {
        await this.evictIdleRuntimes();
      } catch (error) {
        this.onListenerError(error);
      }
    }));
    operation.promise = promise;
    return promise;
  }

  abort(sessionID: string): boolean {
    const operation = this.turns.get(sessionID);
    if (!operation) return false;
    operation.abortRequested = true;
    operation.controller.abort();
    if (operation.runtime) this.touchRuntime(operation.runtime);
    operation.runtime?.session.abort();
    return true;
  }

  pendingPermissions(sessionID: string): PermissionRequest[] {
    const runtime = this.runtimes.get(sessionID);
    if (runtime) this.touchRuntime(runtime);
    return [...(runtime?.pendingPermissions.values() ?? [])];
  }

  pendingQuestions(sessionID: string): QuestionRequest[] {
    const runtime = this.runtimes.get(sessionID);
    if (runtime) this.touchRuntime(runtime);
    return [...(runtime?.pendingQuestions.values() ?? [])];
  }

  replyPermission(
    sessionID: string,
    requestID: string,
    reply: PermissionReply,
    message?: string,
  ): boolean {
    const runtime = this.runtimes.get(sessionID);
    const request = runtime?.pendingPermissions.get(requestID);
    if (!runtime || !request || request.sessionId !== runtime.session.id || !runtime.session.replyPermission) {
      return false;
    }
    this.touchRuntime(runtime);
    runtime.session.replyPermission(requestID, reply, message);
    return true;
  }

  answerQuestion(sessionID: string, requestID: string, answers: string[][]): boolean {
    const runtime = this.runtimes.get(sessionID);
    const request = runtime?.pendingQuestions.get(requestID);
    if (!runtime || !request || request.sessionId !== runtime.session.id || !runtime.session.answerQuestion) {
      return false;
    }
    this.touchRuntime(runtime);
    runtime.session.answerQuestion(requestID, answers);
    return true;
  }

  rejectQuestion(sessionID: string, requestID: string, message?: string): boolean {
    const runtime = this.runtimes.get(sessionID);
    const request = runtime?.pendingQuestions.get(requestID);
    if (!runtime || !request || request.sessionId !== runtime.session.id || !runtime.session.rejectQuestion) {
      return false;
    }
    this.touchRuntime(runtime);
    runtime.session.rejectQuestion(requestID, message);
    return true;
  }

  undo(sessionID: string): Promise<SessionRevertState> {
    this.assertOpen();
    this.assertIdle(sessionID);
    return this.track(this.enqueueMutation(sessionID, async () => {
      const metadata = this.requireMetadata(sessionID);
      const turn = this.archive.listTurns(sessionID).at(-1);
      if (!turn) throw new TuiSessionHostError("ROLLBACK_UNAVAILABLE", "There is no visible turn to undo.");
      const rollback = readyRollback(turn.checkpoint.data);
      if (!rollback && !isPlanModeRollback(turn.checkpoint.data)) {
        throw new TuiSessionHostError(
          "ROLLBACK_UNAVAILABLE",
          `Turn ${turn.id} does not have a ready filesystem checkpoint.`,
        );
      }

      const runtime = this.runtimes.get(sessionID);
      if (runtime) await this.closeRuntime(sessionID, runtime);
      const revision = this.archive.getRevertState(sessionID)?.revision ?? 0;
      if (!rollback) {
        return this.archive.undoToTurn(sessionID, turn.id, {
          expectedRevision: revision,
          updatedAt: this.timestamp(),
        });
      }

      const engine = await this.rollbackEngine(metadata, rollback);
      const release = await this.acquireWorkspace(engine.workspaceRoot);
      try {
        await this.restoreOrThrow(engine, rollback.checkpoint);
        try {
          return this.archive.undoToTurn(sessionID, turn.id, {
            expectedRevision: revision,
            updatedAt: this.timestamp(),
          });
        } catch (error) {
          try {
            const reverse = await this.prepareReverseCheckpoint(
              engine,
              rollback.checkpoint,
              "Could not compensate undo",
            );
            await this.restoreOrThrow(engine, reverse);
          } catch {}
          throw error;
        }
      } finally {
        release();
      }
    }));
  }

  redo(sessionID: string): Promise<SessionRevertState | undefined> {
    this.assertOpen();
    this.assertIdle(sessionID);
    return this.track(this.enqueueMutation(sessionID, async () => {
      const metadata = this.requireMetadata(sessionID);
      const state = this.archive.getRevertState(sessionID);
      if (!state) throw new TuiSessionHostError("ROLLBACK_UNAVAILABLE", "There is no reverted turn to redo.");
      const rollback = readyRollback(state.rollbackData);
      if (!rollback && !isPlanModeRollback(state.rollbackData)) {
        throw new TuiSessionHostError(
          "ROLLBACK_UNAVAILABLE",
          `Turn ${state.boundaryTurnID} does not have a ready filesystem checkpoint.`,
        );
      }

      const runtime = this.runtimes.get(sessionID);
      if (runtime) await this.closeRuntime(sessionID, runtime);
      if (!rollback) {
        return this.archive.redoTurn(sessionID, {
          expectedRevision: state.revision,
          updatedAt: this.timestamp(),
        });
      }

      const engine = await this.rollbackEngine(metadata, rollback);
      const release = await this.acquireWorkspace(engine.workspaceRoot);
      try {
        const reverse = await this.prepareReverseCheckpoint(engine, rollback.checkpoint, "Could not prepare redo");
        await this.restoreOrThrow(engine, reverse);
        try {
          return this.archive.redoTurn(sessionID, {
            expectedRevision: state.revision,
            updatedAt: this.timestamp(),
          });
        } catch (error) {
          try {
            await this.restoreOrThrow(engine, rollback.checkpoint);
          } catch {}
          throw error;
        }
      } finally {
        release();
      }
    }));
  }

  commitRevert(sessionID: string, options: RevertMutationOptions = {}): Promise<SessionMetadata> {
    this.assertOpen();
    this.assertIdle(sessionID);
    return this.track(this.enqueueMutation(sessionID, async () => {
      const runtime = this.runtimes.get(sessionID);
      if (runtime) await this.closeRuntime(sessionID, runtime);
      const state = this.archive.getRevertState(sessionID);
      if (!state) throw new TuiSessionHostError("ROLLBACK_UNAVAILABLE", "There is no revert to commit.");
      const metadata = this.archive.commitRevert(sessionID, {
        expectedRevision: options.expectedRevision ?? state.revision,
        updatedAt: options.updatedAt ?? this.timestamp(),
      });
      this.reverseCheckpoints.delete(sessionID);
      return metadata;
    }));
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const sessionID of this.turns.keys()) this.abort(sessionID);
    this.closePromise = (async () => {
      await Promise.allSettled([...this.tasks]);
      await Promise.allSettled([...this.runtimeCreations.values()]);
      const closed = await Promise.allSettled(
        [...this.runtimes].map(([sessionID, runtime]) => this.closeRuntime(sessionID, runtime)),
      );
      let failure = closed.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
      try {
        this.archive.flush();
      } catch (error) {
        failure ??= error;
      }
      try {
        this.archive.close();
      } catch (error) {
        failure ??= error;
      }
      this.listeners.clear();
      if (failure) throw failure;
    })();
    return this.closePromise;
  }

  private async fork(
    sourceID: string,
    turnID: string | undefined,
    options: ForkSessionOptions | undefined,
  ): Promise<SessionMetadata> {
    this.assertOpen();
    this.requireMetadata(sourceID);
    this.assertIdle(sourceID);
    return this.track(this.enqueueMutation(sourceID, async () => {
      const metadata = turnID
        ? this.archive.forkFromTurn(sourceID, turnID, options)
        : this.archive.forkSession(sourceID, options);
      this.statuses.set(metadata.id, "idle");
      return metadata;
    }));
  }

  private async runModelTurn(operation: TurnOperation): Promise<SessionTurn> {
    const metadata = this.requireMetadata(operation.sessionID);
    const snapshot = metadata.mode === "build"
      ? await this.openBuildSnapshot(metadata)
      : undefined;
    const release = snapshot ? await this.acquireWorkspace(snapshot.key) : () => {};
    let rollbackData = unavailableRollback(
      metadata.workspace,
      "not-applicable",
      metadata.mode === "plan" ? "plan-mode" : "workspace-unavailable",
    );
    let history = this.archive.getModelHistory(operation.sessionID);
    let terminal: Extract<SessionEvent, { type: "finish" | "error" }> | undefined;

    try {
      if (snapshot) rollbackData = await this.captureBefore(snapshot);
      operation.accepted = this.archive.acceptTurn({
        sessionID: operation.sessionID,
        turnID: operation.turnID,
        prompt: operation.archivePrompt,
        acceptedAt: this.timestamp(),
        rollbackData: jsonValue(rollbackData),
      });

      if (!operation.abortRequested && !this.closing) {
        try {
          const runtime = await this.ensureRuntime(metadata, operation.controller.signal);
          operation.runtime = runtime;
          operation.eventPumpBarrier = createEventPumpBarrier();
          runtime.active = operation;
          if (operation.abortRequested || this.closing) {
            runtime.session.abort();
          } else {
            this.publishStatus(operation, "running");
            try {
              await runtime.session.send(operation.prompt);
            } catch (error) {
              operation.eventError ??= asError(error);
            }
            await operation.eventPumpBarrier.promise;
            try {
              history = archiveHistory(runtime.session.snapshotHistory());
            } catch (error) {
              operation.eventError ??= asError(error);
            }
          }
        } catch (error) {
          operation.eventError ??= asError(error);
        }
      }

      terminal = operation.abortRequested || this.closing
        ? { type: "finish", reason: "abort" }
        : operation.eventError
          ? { type: "error", message: operation.eventError.message }
          : operation.terminal ?? { type: "finish", reason: "stop" };
      this.publishStatus(operation, "settling");
      if (snapshot) rollbackData = await this.captureAfter(snapshot);
      const settled = this.archive.settleTurn({
        sessionID: operation.sessionID,
        turnID: operation.turnID,
        status: terminal.type === "error"
          ? "failed"
          : terminal.reason === "abort"
            ? "aborted"
            : "completed",
        settledAt: this.timestamp(),
        terminalEvent: terminal,
        history,
        rollbackData: jsonValue(rollbackData),
      });
      this.publishSessionEvent(settled.event);
      this.publishStatus(
        operation,
        terminal.type === "error" ? "error" : "idle",
        terminal.type === "error" ? terminal.message : undefined,
      );
      return settled.turn;
    } catch (error) {
      const failure = asError(error);
      if (!operation.accepted) {
        this.publishStatus(operation, "error", failure.message);
        throw error;
      }

      this.publishStatus(operation, "settling");
      if (snapshot) rollbackData = await this.captureAfter(snapshot);
      const failedTerminal: Extract<SessionEvent, { type: "error" }> = {
        type: "error",
        message: failure.message,
      };
      let settled: SettledTurn;
      try {
        settled = this.archive.settleTurn({
          sessionID: operation.sessionID,
          turnID: operation.turnID,
          status: "failed",
          settledAt: this.timestamp(),
          terminalEvent: failedTerminal,
          history,
          rollbackData: jsonValue(rollbackData),
        });
      } catch (settleError) {
        this.publishStatus(operation, "error", asError(settleError).message);
        throw settleError;
      }
      this.publishSessionEvent(settled.event);
      this.publishStatus(operation, "error", failure.message);
      return settled.turn;
    } finally {
      if (operation.runtime?.active === operation) {
        this.touchRuntime(operation.runtime);
        operation.runtime.active = undefined;
      }
      release();
    }
  }

  private async runShellTurn(operation: TurnOperation): Promise<SessionTurn> {
    const metadata = this.requireMetadata(operation.sessionID);
    if (metadata.mode === "plan") {
      const error = new TuiSessionHostError(
        "READ_ONLY",
        "Direct shell commands are disabled in read-only plan mode. Switch to build mode first.",
      );
      this.publishStatus(operation, "error", error.message);
      throw error;
    }
    const snapshot = await this.openBuildSnapshot(metadata);
    const release = await this.acquireWorkspace(snapshot.key);
    let rollbackData = unavailableRollback(
      metadata.workspace,
      "not-applicable",
      "workspace-unavailable",
    );
    let history = this.archive.getModelHistory(operation.sessionID);

    try {
      rollbackData = await this.captureBefore(snapshot);
      operation.accepted = this.archive.acceptTurn({
        sessionID: operation.sessionID,
        turnID: operation.turnID,
        prompt: operation.archivePrompt,
        acceptedAt: this.timestamp(),
        rollbackData: jsonValue(rollbackData),
      });

      if (!operation.abortRequested && !this.closing) {
        const runtime = this.runtimes.get(operation.sessionID);
        if (runtime) await this.closeRuntime(operation.sessionID, runtime);
      }

      let result: ShellResult | undefined;
      let shellFailure: Error | undefined;
      const toolCallId = `shell_${operation.turnID}`;
      if (!operation.abortRequested && !this.closing) {
        this.publishStatus(operation, "running");
        if (!operation.abortRequested && !this.closing) {
          this.appendDurableEvent(operation, {
            type: "tool-call-start",
            toolCallId,
            toolName: "run_shell",
            args: { command: operation.prompt, cwd: metadata.workspace },
          });
          try {
            result = operation.abortRequested || this.closing
              ? abortedShellResult(operation.prompt)
              : await this.shellExecutor(
                  operation.prompt,
                  metadata.workspace ?? process.cwd(),
                  operation.timeoutMs!,
                  operation.controller.signal,
                );
          } catch (error) {
            shellFailure = asError(error);
            result = failedShellResult(operation.prompt, shellFailure);
          }
          if (!operation.abortRequested && !result.timedOut && result.exitCode === null) {
            shellFailure ??= new Error(shellFailureMessage(result));
          }
          history = appendShellHistory(history, operation.prompt, result);
          this.appendDurableEvent(operation, {
            type: "tool-result",
            toolCallId,
            toolName: "run_shell",
            result,
            isError: result.exitCode !== 0 || result.timedOut,
          });
        }
      }

      const terminal: Extract<SessionEvent, { type: "finish" | "error" }> =
        operation.abortRequested || this.closing
          ? { type: "finish", reason: "abort" }
          : shellFailure
            ? { type: "error", message: shellFailure.message }
            : { type: "finish", reason: "stop" };
      this.publishStatus(operation, "settling");
      rollbackData = await this.captureAfter(snapshot);
      const settled = this.archive.settleTurn({
        sessionID: operation.sessionID,
        turnID: operation.turnID,
        status: terminal.type === "error"
          ? "failed"
          : terminal.reason === "abort"
            ? "aborted"
            : "completed",
        settledAt: this.timestamp(),
        terminalEvent: terminal,
        history,
        rollbackData: jsonValue(rollbackData),
      });
      this.publishSessionEvent(settled.event);
      this.publishStatus(
        operation,
        terminal.type === "error" ? "error" : "idle",
        terminal.type === "error" ? terminal.message : undefined,
      );
      return settled.turn;
    } catch (error) {
      const failure = asError(error);
      if (!operation.accepted) {
        this.publishStatus(operation, "error", failure.message);
        throw error;
      }

      this.publishStatus(operation, "settling");
      rollbackData = await this.captureAfter(snapshot);
      const terminal: Extract<SessionEvent, { type: "error" }> = {
        type: "error",
        message: failure.message,
      };
      let settled: SettledTurn;
      try {
        settled = this.archive.settleTurn({
          sessionID: operation.sessionID,
          turnID: operation.turnID,
          status: "failed",
          settledAt: this.timestamp(),
          terminalEvent: terminal,
          history,
          rollbackData: jsonValue(rollbackData),
        });
      } catch (settleError) {
        this.publishStatus(operation, "error", asError(settleError).message);
        throw settleError;
      }
      this.publishSessionEvent(settled.event);
      this.publishStatus(operation, "error", failure.message);
      return settled.turn;
    } finally {
      release();
    }
  }

  private appendDurableEvent(operation: TurnOperation, event: SessionEvent): SessionEventRecord {
    const record = this.archive.appendEvent({
      sessionID: operation.sessionID,
      turnID: operation.turnID,
      at: this.timestamp(),
      event,
    });
    this.publishSessionEvent(record);
    return record;
  }

  private async ensureRuntime(metadata: SessionMetadata, signal: AbortSignal): Promise<RuntimeEntry> {
    const existing = this.runtimes.get(metadata.id);
    if (existing) {
      if (existing.closing) {
        await existing.closing;
        return this.ensureRuntime(metadata, signal);
      }
      this.touchRuntime(existing);
      return existing;
    }
    const pending = this.runtimeCreations.get(metadata.id);
    if (pending) {
      const runtime = await pending;
      this.touchRuntime(runtime);
      return runtime;
    }

    const creation = (async () => {
      const session = await this.runtimeFactory({
        metadata,
        initialHistory: runtimeHistory(this.archive.getModelHistory(metadata.id)),
        signal,
      });
      if (session.id !== metadata.id) {
        await session.close();
        throw new Error(`Runtime ${session.id} does not match archived session ${metadata.id}.`);
      }
      const runtime: RuntimeEntry = {
        session,
        metadata,
        pump: Promise.resolve(),
        lastUsed: 0,
        pendingPermissions: new Map((session.pendingPermissions?.() ?? []).map((request) => [request.id, request])),
        pendingQuestions: new Map((session.pendingQuestions?.() ?? []).map((request) => [request.id, request])),
      };
      this.touchRuntime(runtime);
      this.runtimes.set(metadata.id, runtime);
      runtime.pump = this.pump(runtime);
      return runtime;
    })();
    this.runtimeCreations.set(metadata.id, creation);
    try {
      return await creation;
    } finally {
      if (this.runtimeCreations.get(metadata.id) === creation) this.runtimeCreations.delete(metadata.id);
    }
  }

  private async pump(runtime: RuntimeEntry): Promise<void> {
    try {
      for await (const event of runtime.session.events) {
        const operation = runtime.active;
        this.touchRuntime(runtime);
        if (event.type === "finish" || event.type === "error") {
          this.flushPendingDelta(runtime);
          if (operation && !operation.terminal) operation.terminal = event;
          operation?.eventPumpBarrier?.release();
          continue;
        }

        if (isCoalescableDelta(event)) {
          this.bufferDelta(runtime, operation, event);
          continue;
        }
        this.flushPendingDelta(runtime);
        this.persistRuntimeEvent(runtime, operation, event, this.timestamp());
      }
    } catch (error) {
      const operation = runtime.active;
      if (operation) {
        operation.eventError ??= asError(error);
        runtime.session.abort();
      }
    } finally {
      this.flushPendingDelta(runtime);
      runtime.active?.eventPumpBarrier?.release();
    }
  }

  private bufferDelta(
    runtime: RuntimeEntry,
    operation: TurnOperation | undefined,
    event: SessionEvent,
  ): void {
    const turnID = operation?.accepted ? operation.turnID : undefined;
    const pending = runtime.pendingDelta;
    if (pending && pending.turnID === turnID) {
      const coalesced = coalesceDeltaEvents(pending.event, event);
      if (coalesced) {
        pending.event = coalesced;
        return;
      }
    }
    this.flushPendingDelta(runtime);
    const at = this.timestamp();
    const timer = setTimeout(() => this.flushPendingDelta(runtime), this.deltaCoalesceIntervalMs);
    runtime.pendingDelta = {
      event: { ...event },
      at,
      turnID,
      operation,
      timer,
    };
  }

  private flushPendingDelta(runtime: RuntimeEntry): void {
    const pending = runtime.pendingDelta;
    if (!pending) return;
    runtime.pendingDelta = undefined;
    clearTimeout(pending.timer);
    this.persistRuntimeEvent(runtime, pending.operation, pending.event, pending.at, pending.turnID);
  }

  private persistRuntimeEvent(
    runtime: RuntimeEntry,
    operation: TurnOperation | undefined,
    event: SessionEvent,
    at: number,
    turnID = operation?.accepted ? operation.turnID : undefined,
  ): void {
    let record: SessionEventRecord;
    try {
      record = this.archive.appendEvent({
        sessionID: runtime.metadata.id,
        turnID,
        at,
        event,
      });
    } catch (error) {
      if (operation) {
        operation.eventError ??= asError(error);
        runtime.session.abort();
      }
      return;
    }

    this.applyControlEvent(runtime, event);
    if (event.type === "title-change") {
      try {
        runtime.metadata = this.archive.updateSession(
          runtime.metadata.id,
          { title: event.title },
          this.timestamp(),
        );
      } catch (error) {
        if (operation) operation.eventError ??= asError(error);
      }
    }
    this.publishSessionEvent(record);
    if (operation) this.publishInteractionStatus(runtime, operation, event);
  }

  private applyControlEvent(runtime: RuntimeEntry, event: SessionEvent): void {
    if (event.type === "permission-asked") runtime.pendingPermissions.set(event.request.id, event.request);
    if (event.type === "permission-replied") runtime.pendingPermissions.delete(event.requestId);
    if (event.type === "question-asked") runtime.pendingQuestions.set(event.request.id, event.request);
    if (event.type === "question-answered" || event.type === "question-rejected") {
      runtime.pendingQuestions.delete(event.requestId);
    }
  }

  private publishInteractionStatus(
    runtime: RuntimeEntry,
    operation: TurnOperation,
    event: SessionEvent,
  ): void {
    if (event.type === "permission-asked" || event.type === "question-asked") {
      this.publishStatus(operation, "waiting");
      return;
    }
    if (
      event.type === "permission-replied"
      || event.type === "question-answered"
      || event.type === "question-rejected"
    ) {
      if (runtime.pendingPermissions.size === 0 && runtime.pendingQuestions.size === 0) {
        this.publishStatus(operation, "running");
      }
    }
  }

  private canMutateRuntime(
    runtime: RuntimeEntry,
    previous: SessionMetadata,
    updated: SessionMetadata,
    patch: SessionUpdate,
  ): boolean {
    if (runtime.active) return false;
    if (updated.workspace !== previous.workspace) return false;
    if (patch.model && updated.model.providerID !== previous.model.providerID) return false;
    if (patch.model && !runtime.session.setModel) return false;
    if (patch.mode && !runtime.session.setMode) return false;
    if (Object.hasOwn(patch, "effort") && !runtime.session.setReasoningEffort) return false;
    return true;
  }

  private async closeRuntime(sessionID: string, runtime: RuntimeEntry): Promise<void> {
    if (runtime.closing) return runtime.closing;
    runtime.closing = (async () => {
      this.flushPendingDelta(runtime);
      await runtime.session.close();
      await runtime.pump;
      if (this.runtimes.get(sessionID) === runtime) this.runtimes.delete(sessionID);
    })();
    return runtime.closing;
  }

  private touchRuntime(runtime: RuntimeEntry): void {
    runtime.lastUsed = ++this.runtimeUseSequence;
  }

  private async evictIdleRuntimes(): Promise<void> {
    while (!this.closing) {
      const idle = [...this.runtimes.entries()]
        .filter(([sessionID, runtime]) => this.canEvictRuntime(sessionID, runtime))
        .sort((left, right) => left[1].lastUsed - right[1].lastUsed);
      if (idle.length <= this.maxIdleRuntimes) return;
      const oldest = idle[0];
      if (!oldest) return;
      await this.closeRuntime(oldest[0], oldest[1]);
    }
  }

  private canEvictRuntime(sessionID: string, runtime: RuntimeEntry): boolean {
    const status = this.statuses.get(sessionID);
    return !runtime.active
      && !runtime.closing
      && !this.turns.has(sessionID)
      && !this.runtimeCreations.has(sessionID)
      && runtime.pendingPermissions.size === 0
      && runtime.pendingQuestions.size === 0
      && (status === "idle" || status === "error");
  }

  private async openBuildSnapshot(metadata: SessionMetadata): Promise<BuildSnapshotState> {
    if (!metadata.workspace) {
      return { workspace: null, key: `session:${metadata.id}` };
    }
    const canonical = await canonicalPath(metadata.workspace);
    try {
      const opened = await this.openSnapshotEngine(metadata.workspace, this.snapshotOptions);
      if (opened.status === "ready") {
        return {
          workspace: opened.workspaceRoot,
          key: opened.workspaceRoot,
          engine: opened.engine,
        };
      }
      return { workspace: canonical, key: canonical, openFailure: opened };
    } catch (error) {
      return {
        workspace: canonical,
        key: canonical,
        openFailure: {
          status: "unsupported",
          reason: "snapshot-open-failed",
          detail: asError(error).message,
        },
      };
    }
  }

  private async recoverPendingRollback(
    metadata: SessionMetadata,
    turn: SessionTurn,
    pending: Extract<TuiFilesystemRollback, { status: "pending" }>,
  ): Promise<void> {
    const snapshot = await this.openBuildSnapshot(metadata);
    const release = await this.acquireWorkspace(snapshot.key);
    const beforeOmissions = pending.coverage.omissions
      .filter((omission) => omission.phase === "before")
      .map(({ phase: _, ...omission }) => omission);
    try {
      let rollbackData: TuiRollbackPayload;
      if (!snapshot.engine) {
        rollbackData = unavailableRollback(
          snapshot.workspace,
          "open",
          snapshot.openFailure?.reason ?? "workspace-unavailable",
          snapshot.openFailure?.detail,
          [],
          beforeOmissions,
        );
      } else if (
        snapshot.workspace !== pending.workspace
        || snapshot.engine.workspaceId !== pending.before.workspaceId
      ) {
        rollbackData = unavailableRollback(
          snapshot.workspace,
          "open",
          "workspace-mismatch",
          "The pending checkpoint belongs to another workspace.",
          [],
          beforeOmissions,
        );
      } else {
        snapshot.before = {
          status: "captured",
          snapshot: pending.before,
          omissions: beforeOmissions,
        };
        rollbackData = await this.captureAfter(snapshot);
      }
      this.archive.updateInterruptedTurnRollback(
        metadata.id,
        turn.id,
        jsonValue(rollbackData),
      );
    } finally {
      release();
    }
  }

  private async captureBefore(snapshot: BuildSnapshotState): Promise<TuiRollbackPayload> {
    if (!snapshot.engine) {
      return unavailableRollback(
        snapshot.workspace,
        "open",
        snapshot.openFailure?.reason ?? "workspace-unavailable",
        snapshot.openFailure?.detail,
      );
    }
    try {
      snapshot.before = await snapshot.engine.capture();
    } catch (error) {
      return unavailableRollback(snapshot.workspace, "before", "capture-failed", asError(error).message);
    }
    if (snapshot.before.status !== "captured") {
      return unavailableRollback(
        snapshot.workspace,
        "before",
        snapshot.before.reason,
        snapshot.before.detail,
        snapshot.before.paths,
      );
    }
    return {
      version: 1,
      filesystem: {
        status: "pending",
        workspace: snapshot.workspace!,
        before: snapshot.before.snapshot,
        coverage: coverage([], snapshot.before.omissions, []),
        warnings: rollbackWarnings(snapshot.before.omissions),
      },
    };
  }

  private async captureAfter(snapshot: BuildSnapshotState): Promise<TuiRollbackPayload> {
    if (!snapshot.engine) {
      return unavailableRollback(
        snapshot.workspace,
        "open",
        snapshot.openFailure?.reason ?? "workspace-unavailable",
        snapshot.openFailure?.detail,
      );
    }

    let after: Awaited<ReturnType<WorkspaceSnapshotEngine["capture"]>>;
    try {
      after = await snapshot.engine.capture();
    } catch (error) {
      return unavailableRollback(snapshot.workspace, "after", "capture-failed", asError(error).message);
    }
    if (!snapshot.before || snapshot.before.status !== "captured") {
      const before = snapshot.before;
      return unavailableRollback(
        snapshot.workspace,
        "before",
        before?.status === "skipped" ? before.reason : "capture-unavailable",
        before?.status === "skipped" ? before.detail : undefined,
        before?.status === "skipped" ? before.paths : [],
      );
    }
    if (after.status !== "captured") {
      return unavailableRollback(
        snapshot.workspace,
        "after",
        after.reason,
        after.detail,
        after.paths,
        snapshot.before.omissions,
      );
    }

    let checkpoint: Awaited<ReturnType<WorkspaceSnapshotEngine["checkpoint"]>>;
    try {
      checkpoint = await snapshot.engine.checkpoint(snapshot.before.snapshot, after.snapshot);
    } catch (error) {
      return unavailableRollback(
        snapshot.workspace,
        "checkpoint",
        "checkpoint-failed",
        asError(error).message,
        [],
        snapshot.before.omissions,
        after.omissions,
      );
    }
    if (checkpoint.status !== "ready") {
      return unavailableRollback(
        snapshot.workspace,
        "checkpoint",
        checkpoint.reason,
        checkpoint.detail,
        checkpoint.paths,
        snapshot.before.omissions,
        after.omissions,
      );
    }
    return {
      version: 1,
      filesystem: {
        status: "ready",
        workspace: snapshot.workspace!,
        checkpoint: checkpoint.checkpoint,
        coverage: coverage(
          checkpoint.checkpoint.changes.map((change) => change.path),
          snapshot.before.omissions,
          after.omissions,
        ),
        warnings: rollbackWarnings([...snapshot.before.omissions, ...after.omissions]),
      },
    };
  }

  private async rollbackEngine(
    metadata: SessionMetadata,
    rollback: Extract<TuiFilesystemRollback, { status: "ready" }>,
  ): Promise<WorkspaceSnapshotEngine> {
    if (!metadata.workspace) {
      throw new TuiSessionHostError("ROLLBACK_UNAVAILABLE", "This session has no workspace to restore.");
    }
    let opened: OpenWorkspaceSnapshotResult;
    try {
      opened = await this.openSnapshotEngine(metadata.workspace, this.snapshotOptions);
    } catch (error) {
      throw new TuiSessionHostError("ROLLBACK_UNAVAILABLE", asError(error).message, { cause: error });
    }
    if (opened.status !== "ready") {
      throw new TuiSessionHostError(
        "ROLLBACK_UNAVAILABLE",
        `Workspace rollback is unavailable: ${opened.reason}${opened.detail ? ` (${opened.detail})` : ""}`,
      );
    }
    if (
      opened.engine.workspaceId !== rollback.checkpoint.workspaceId
      || opened.workspaceRoot !== rollback.workspace
    ) {
      throw new TuiSessionHostError("ROLLBACK_UNAVAILABLE", "The checkpoint belongs to another workspace.");
    }
    return opened.engine;
  }

  private async restoreOrThrow(
    engine: WorkspaceSnapshotEngine,
    checkpoint: WorkspaceCheckpoint,
  ): Promise<void> {
    let restored: Awaited<ReturnType<WorkspaceSnapshotEngine["restore"]>>;
    try {
      restored = await engine.restore(checkpoint);
    } catch (error) {
      throw new TuiSessionHostError("ROLLBACK_FAILED", asError(error).message, { cause: error });
    }
    if (restored.status === "conflict") {
      throw new TuiSessionHostError(
        "ROLLBACK_CONFLICT",
        `Workspace changed since the turn: ${restored.conflicts.map((conflict) => conflict.path).join(", ")}`,
      );
    }
    if (restored.status === "skipped") {
      throw new TuiSessionHostError("ROLLBACK_FAILED", snapshotFailureMessage("Could not restore workspace", restored));
    }
  }

  private async prepareReverseCheckpoint(
    engine: WorkspaceSnapshotEngine,
    checkpoint: WorkspaceCheckpoint,
    failurePrefix: string,
  ): Promise<WorkspaceCheckpoint> {
    const cacheKey = reverseCheckpointKey(checkpoint);
    const cached = this.reverseCheckpoints.get(cacheKey);
    if (cached) return cached;
    const result = await engine.checkpoint(checkpoint.current, checkpoint.target);
    if (result.status !== "ready") {
      throw new TuiSessionHostError(
        "ROLLBACK_FAILED",
        snapshotFailureMessage(failurePrefix, result),
      );
    }
    this.reverseCheckpoints.set(cacheKey, result.checkpoint);
    return result.checkpoint;
  }

  private publishSessionEvent(record: SessionEventRecord): void {
    this.publish({
      type: "session-event",
      sessionID: record.sessionID,
      turnID: record.turnID,
      event: record.event,
      record,
    });
  }

  private publishStatus(operation: TurnOperation, status: TuiSessionStatus, error?: string): void {
    if (this.statuses.get(operation.sessionID) === status && !error) return;
    this.statuses.set(operation.sessionID, status);
    this.publish({
      type: "status",
      sessionID: operation.sessionID,
      turnID: operation.turnID,
      status,
      at: this.timestamp(),
      error,
    });
  }

  private publish(event: TuiSessionHostEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.onListenerError(error);
      }
    }
  }

  private enqueueMutation<T>(sessionID: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(sessionID) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.mutationTails.set(sessionID, tail);
    void tail.finally(() => {
      if (this.mutationTails.get(sessionID) === tail) this.mutationTails.delete(sessionID);
    });
    return result;
  }

  private async acquireWorkspace(workspace: string): Promise<() => void> {
    const previous = this.workspaceTails.get(workspace) ?? Promise.resolve();
    let releaseGate = () => {};
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.workspaceTails.set(workspace, tail);
    await previous.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      if (this.workspaceTails.get(workspace) === tail) this.workspaceTails.delete(workspace);
    };
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.tasks.add(promise);
    void promise.finally(() => this.tasks.delete(promise)).catch(() => undefined);
    return promise;
  }

  private assertOpen(): void {
    if (this.closing) throw new TuiSessionHostError("CLOSED", "The TUI session host is closed.");
  }

  private assertIdle(sessionID: string): void {
    this.requireMetadata(sessionID);
    if (this.turns.has(sessionID)) {
      throw new TuiSessionHostError("BUSY", `Session ${sessionID} is not idle.`);
    }
  }

  private assertTurnAvailable(sessionID: string): void {
    if (this.turns.has(sessionID)) {
      throw new TuiSessionHostError("BUSY", `Session ${sessionID} already has a turn in progress`);
    }
  }

  private requireMetadata(sessionID: string): SessionMetadata {
    const metadata = this.archive.getSession(sessionID);
    if (!metadata) throw new TuiSessionHostError("NOT_FOUND", `Unknown session: ${sessionID}`);
    return metadata;
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Host clock returned an invalid timestamp.");
    return value;
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function isCoalescableDelta(event: SessionEvent): boolean {
  return event.type === "text-delta"
    || event.type === "reasoning-delta"
    || (event.type === "subagent-event" && isCoalescableDelta(event.event));
}

function coalesceDeltaEvents(left: SessionEvent, right: SessionEvent): SessionEvent | undefined {
  if (left.type === "text-delta" && right.type === "text-delta") {
    return { type: "text-delta", text: left.text + right.text };
  }
  if (left.type === "reasoning-delta" && right.type === "reasoning-delta" && left.id === right.id) {
    return { type: "reasoning-delta", id: left.id, text: left.text + right.text };
  }
  if (
    left.type === "subagent-event"
    && right.type === "subagent-event"
    && left.toolCallId === right.toolCallId
    && left.sessionId === right.sessionId
  ) {
    const event = coalesceDeltaEvents(left.event, right.event);
    if (event) return { ...left, event };
  }
  return undefined;
}

function coverage(
  changedPaths: string[],
  before: SnapshotOmission[],
  after: SnapshotOmission[],
): TuiRollbackCoverage {
  return {
    scope: "workspace-files",
    changedPaths,
    omissions: [
      ...before.map((omission) => ({ ...omission, phase: "before" as const })),
      ...after.map((omission) => ({ ...omission, phase: "after" as const })),
    ],
  };
}

function unavailableRollback(
  workspace: string | null,
  phase: Extract<TuiFilesystemRollback, { status: "unavailable" }>["phase"],
  reason: string,
  detail?: string,
  paths: string[] = [],
  beforeOmissions: SnapshotOmission[] = [],
  afterOmissions: SnapshotOmission[] = [],
): TuiRollbackPayload {
  return {
    version: 1,
    filesystem: {
      status: "unavailable",
      workspace,
      phase,
      reason,
      ...(detail ? { detail } : {}),
      paths,
      coverage: {
        ...coverage([], beforeOmissions, afterOmissions),
        scope: "none",
      },
      warnings: rollbackWarnings([...beforeOmissions, ...afterOmissions]),
    },
  };
}

function rollbackWarnings(omissions: SnapshotOmission[]): string[] {
  const warnings: string[] = [...ROLLBACK_WARNINGS];
  if (omissions.length) {
    warnings.push("Ignored or otherwise omitted paths listed in coverage are not restored.");
  }
  return warnings;
}

function readyRollback(
  value: JsonValue,
): Extract<TuiFilesystemRollback, { status: "ready" }> | undefined {
  const filesystem = rollbackFilesystem(value);
  if (!filesystem) return undefined;
  if (
    filesystem.status !== "ready"
    || typeof filesystem.workspace !== "string"
    || !isWorkspaceCheckpoint(filesystem.checkpoint)
  ) {
    return undefined;
  }
  return filesystem as unknown as Extract<TuiFilesystemRollback, { status: "ready" }>;
}

function pendingRollback(
  value: JsonValue,
): Extract<TuiFilesystemRollback, { status: "pending" }> | undefined {
  const filesystem = rollbackFilesystem(value);
  if (
    !filesystem
    || filesystem.status !== "pending"
    || typeof filesystem.workspace !== "string"
    || !isWorkspaceSnapshot(filesystem.before)
    || !isPendingCoverage(filesystem.coverage)
    || !Array.isArray(filesystem.warnings)
    || !filesystem.warnings.every((warning) => typeof warning === "string")
  ) {
    return undefined;
  }
  return filesystem as unknown as Extract<TuiFilesystemRollback, { status: "pending" }>;
}

function isPlanModeRollback(value: JsonValue): boolean {
  const filesystem = rollbackFilesystem(value);
  return filesystem?.status === "unavailable"
    && filesystem.phase === "not-applicable"
    && filesystem.reason === "plan-mode";
}

function rollbackFilesystem(value: JsonValue): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1
    || !payload.filesystem
    || typeof payload.filesystem !== "object"
    || Array.isArray(payload.filesystem)
  ) {
    return undefined;
  }
  return payload.filesystem as Record<string, unknown>;
}

function isPendingCoverage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<TuiRollbackCoverage>;
  return candidate.scope === "workspace-files"
    && Array.isArray(candidate.changedPaths)
    && candidate.changedPaths.every((path) => typeof path === "string")
    && Array.isArray(candidate.omissions)
    && candidate.omissions.every((omission) => (
      (omission.phase === "before" || omission.phase === "after")
      && (omission.reason === "ignored-untracked" || omission.reason === "ignored-query-unavailable")
      && Array.isArray(omission.paths)
      && omission.paths.every((path) => typeof path === "string")
    ));
}

function isWorkspaceCheckpoint(value: unknown): value is WorkspaceCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Partial<WorkspaceCheckpoint>;
  return typeof checkpoint.workspaceId === "string"
    && isWorkspaceSnapshot(checkpoint.target)
    && isWorkspaceSnapshot(checkpoint.current)
    && Array.isArray(checkpoint.changes)
    && Array.isArray(checkpoint.fingerprints);
}

function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<WorkspaceSnapshot>;
  return typeof snapshot.workspaceId === "string"
    && typeof snapshot.tree === "string"
    && typeof snapshot.ref === "string";
}

function jsonValue(value: TuiRollbackPayload): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function runtimeHistory(history: ModelHistory): ModelMessage[] {
  return structuredClone(history) as unknown as ModelMessage[];
}

function archiveHistory(history: ModelMessage[]): ModelHistory {
  return JSON.parse(JSON.stringify(history)) as ModelHistory;
}

function createEventPumpBarrier(): EventPumpBarrier {
  let release = () => {};
  const promise = new Promise<void>((resolveBarrier) => {
    release = resolveBarrier;
  });
  return { promise, release };
}

function appendShellHistory(
  history: ModelHistory,
  command: string,
  result: ShellResult,
): ModelHistory {
  const output = {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    truncated: result.truncated,
  };
  return [
    ...history,
    { role: "user", content: `Direct shell command:\n${JSON.stringify(command)}` },
    { role: "assistant", content: `Direct shell result:\n${JSON.stringify(output)}` },
  ];
}

function abortedShellResult(command: string): ShellResult {
  return {
    command,
    exitCode: null,
    stdout: "",
    stderr: "Command aborted before execution.",
    timedOut: false,
    truncated: false,
  };
}

function failedShellResult(command: string, error: Error): ShellResult {
  return {
    command,
    exitCode: null,
    stdout: "",
    stderr: error.message,
    timedOut: false,
    truncated: false,
  };
}

function shellFailureMessage(result: ShellResult): string {
  const detail = result.stderr.trim();
  return detail || "The shell process failed to start.";
}

function reverseCheckpointKey(checkpoint: WorkspaceCheckpoint): string {
  return `${checkpoint.workspaceId}:${checkpoint.current.tree}:${checkpoint.target.tree}`;
}

function snapshotFailureMessage(
  prefix: string,
  result: { reason: string; paths: string[]; detail?: string },
): string {
  const paths = result.paths.length ? ` [${result.paths.join(", ")}]` : "";
  return `${prefix}: ${result.reason}${paths}${result.detail ? ` (${result.detail})` : ""}`;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
