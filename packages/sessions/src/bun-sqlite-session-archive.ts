import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  SessionArchiveError,
  type AcceptTurnInput,
  type AppendEventInput,
  type ArchivedSession,
  type CreateSessionInput,
  type ForkSessionOptions,
  type JsonValue,
  type ModelHistory,
  type RecentArchivedSession,
  type RecentSessionLoadOptions,
  type RevertBoundary,
  type RevertMutationOptions,
  type RollbackCheckpoint,
  type SaveDraftInput,
  type SessionArchive,
  type SessionDraft,
  type SessionEvent,
  type SessionEventRecord,
  type SessionMetadata,
  type SessionRevertState,
  type SessionTurn,
  type SessionTurnSummary,
  type SessionUpdate,
  type SettleTurnInput,
  type SettledTurn,
  type TurnStatus,
} from "./types.ts";
import {
  assertID,
  assertJsonValue,
  assertMode,
  assertModelHistory,
  assertModelRef,
  assertNonEmptyString,
  assertNonNegativeInteger,
  assertRollbackCheckpoint,
  assertSessionEvent,
  assertString,
  assertTimestamp,
  encodeJson,
  parseJson,
  parseModelHistory,
  parseRollbackCheckpoint,
  parseSessionEvent,
} from "./validation.ts";

export const SESSION_SCHEMA_VERSION = 3;

const MIGRATIONS: readonly string[] = [
  `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY CHECK (length(id) > 0),
      title TEXT NOT NULL CHECK (length(title) > 0),
      workspace TEXT,
      provider_id TEXT NOT NULL CHECK (length(provider_id) > 0),
      model_id TEXT NOT NULL CHECK (length(model_id) > 0),
      mode TEXT NOT NULL CHECK (mode IN ('build', 'plan')),
      effort TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      turn_count INTEGER NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
      next_event_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_event_seq >= 1)
    ) STRICT;

    CREATE INDEX sessions_updated_idx ON sessions(updated_at DESC, id);

    CREATE TABLE turns (
      id TEXT PRIMARY KEY CHECK (length(id) > 0),
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
      prompt TEXT NOT NULL CHECK (length(prompt) > 0),
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'aborted', 'interrupted')),
      accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0),
      settled_at INTEGER,
      finish_reason TEXT,
      error_message TEXT,
      boundary_seq INTEGER NOT NULL CHECK (boundary_seq >= 1),
      rollback_checkpoint_json TEXT NOT NULL CHECK (json_valid(rollback_checkpoint_json)),
      UNIQUE (session_id, ordinal),
      UNIQUE (session_id, id),
      CHECK (
        (status = 'running' AND settled_at IS NULL)
        OR (status <> 'running' AND settled_at IS NOT NULL AND settled_at >= accepted_at)
      )
    ) STRICT;

    CREATE UNIQUE INDEX turns_one_running_idx ON turns(session_id) WHERE status = 'running';
    CREATE INDEX turns_session_idx ON turns(session_id, ordinal);

    CREATE TABLE events (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL CHECK (seq >= 1),
      turn_id TEXT,
      at INTEGER NOT NULL CHECK (at >= 0),
      event_type TEXT NOT NULL CHECK (length(event_type) > 0),
      event_json TEXT NOT NULL CHECK (json_valid(event_json)),
      PRIMARY KEY (session_id, seq),
      FOREIGN KEY (session_id, turn_id) REFERENCES turns(session_id, id) ON DELETE CASCADE
    ) STRICT, WITHOUT ROWID;

    CREATE INDEX events_turn_idx ON events(session_id, turn_id, seq);

    CREATE TABLE model_histories (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      history_json TEXT NOT NULL CHECK (json_valid(history_json)),
      through_turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT;
  `,
  `
    CREATE TABLE drafts (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      PRIMARY KEY (session_id, revision)
    ) STRICT, WITHOUT ROWID;
  `,
  `
    CREATE TABLE session_reverts (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      boundary_turn_id TEXT NOT NULL CHECK (length(boundary_turn_id) > 0),
      boundary_ordinal INTEGER NOT NULL CHECK (boundary_ordinal >= 1),
      boundary_seq INTEGER NOT NULL CHECK (boundary_seq >= 1),
      original_turn_count INTEGER NOT NULL CHECK (original_turn_count >= boundary_ordinal),
      original_history_json TEXT NOT NULL CHECK (json_valid(original_history_json)),
      original_through_turn_id TEXT,
      rollback_data_json TEXT NOT NULL CHECK (json_valid(rollback_data_json)),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
    ) STRICT;
  `,
];

interface SessionRow {
  id: string;
  title: string;
  workspace: string | null;
  provider_id: string;
  model_id: string;
  mode: string;
  effort: string | null;
  created_at: number;
  updated_at: number;
  turn_count: number;
  next_event_seq: number;
}

interface TurnRow {
  id: string;
  session_id: string;
  ordinal: number;
  prompt: string;
  status: string;
  accepted_at: number;
  settled_at: number | null;
  finish_reason: string | null;
  error_message: string | null;
  boundary_seq: number;
  rollback_checkpoint_json: string;
}

type TurnSummaryRow = Omit<TurnRow, "rollback_checkpoint_json">;

interface EventRow {
  session_id: string;
  seq: number;
  turn_id: string | null;
  at: number;
  event_type: string;
  event_json: string;
}

interface HistoryRow {
  history_json: string;
  through_turn_id: string | null;
  updated_at: number;
}

interface DraftRow {
  session_id: string;
  revision: number;
  text: string;
  created_at: number;
}

interface RevertRow {
  session_id: string;
  revision: number;
  boundary_turn_id: string;
  boundary_ordinal: number;
  boundary_seq: number;
  original_turn_count: number;
  original_history_json: string;
  original_through_turn_id: string | null;
  rollback_data_json: string;
  created_at: number;
  updated_at: number;
}

export interface BunSQLiteSessionArchiveOptions {
  filename: string;
  busyTimeoutMs?: number;
  /** Running turns are marked interrupted on open by default. */
  recoverInterrupted?: boolean;
  now?: () => number;
}

type InMemoryOptions = Omit<BunSQLiteSessionArchiveOptions, "filename">;

/** Synchronous durable session archive backed by Bun's built-in SQLite driver. */
export class BunSQLiteSessionArchive implements SessionArchive {
  private readonly db: Database;
  private readonly leaseDb: Database | undefined;
  private readonly now: () => number;
  private closed = false;

  static inMemory(options: InMemoryOptions = {}): BunSQLiteSessionArchive {
    return new BunSQLiteSessionArchive({ ...options, filename: ":memory:" });
  }

  constructor(options: BunSQLiteSessionArchiveOptions | string) {
    const normalized = typeof options === "string" ? { filename: options } : options;
    assertNonEmptyString(normalized.filename, "filename");
    const busyTimeoutMs = normalized.busyTimeoutMs ?? 5_000;
    assertNonNegativeInteger(busyTimeoutMs, "busyTimeoutMs");
    const isMemory = isMemoryFilename(normalized.filename);
    if (!isMemory) mkdirSync(dirname(normalized.filename), { recursive: true });

    this.now = normalized.now ?? Date.now;
    const leaseDb = isMemory ? undefined : acquireFileLease(normalized.filename);
    let db: Database;
    try {
      db = new Database(normalized.filename, { create: true, readwrite: true, strict: true });
    } catch (error) {
      closeIgnoringErrors(leaseDb);
      throw error;
    }
    this.db = db;
    this.leaseDb = leaseDb;
    try {
      this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.migrate();
      if (normalized.recoverInterrupted !== false) this.recoverInterruptedTurns(this.now());
    } catch (error) {
      this.closed = true;
      closeIgnoringErrors(this.db);
      closeIgnoringErrors(this.leaseDb);
      throw error;
    }
  }

  listSessions(): SessionMetadata[] {
    this.ensureOpen();
    return this.db.query<SessionRow, []>(`
      SELECT * FROM sessions ORDER BY updated_at DESC, id
    `).all().map(sessionFromRow);
  }

  getSession(id: string): SessionMetadata | undefined {
    this.ensureOpen();
    assertID(id, "session id");
    const row = this.sessionRow(id);
    return row ? sessionFromRow(row) : undefined;
  }

  loadSession(id: string): ArchivedSession | undefined {
    const metadata = this.getSession(id);
    if (!metadata) return undefined;
    return {
      metadata,
      turns: this.listTurns(id),
      events: this.listVisibleEvents(id),
      history: this.getModelHistory(id),
      draft: this.getDraft(id),
    };
  }

  loadRecentSession(
    id: string,
    options: RecentSessionLoadOptions,
  ): RecentArchivedSession | undefined {
    this.ensureOpen();
    assertInputKeys(options, ["eventLimit", "turnLimit"], "recent session options");
    assertRecentLimit(options.eventLimit, "eventLimit");
    assertRecentLimit(options.turnLimit, "turnLimit");
    const metadata = this.getSession(id);
    if (!metadata) return undefined;

    const turns = this.listRecentVisibleTurns(id, options.turnLimit);
    const recentEvents = this.recentVisibleEvents(id, options.eventLimit);
    const earliestTurnSeq = turns[0]?.boundarySeq;
    const events = metadata.turnCount > turns.length && earliestTurnSeq !== undefined
      ? recentEvents.events.filter((record) => record.seq >= earliestTurnSeq)
      : recentEvents.events;
    return {
      metadata,
      turns,
      events,
      draft: this.getDraft(id),
      window: {
        eventsOmitted: recentEvents.omitted || events.length < recentEvents.events.length,
        turnsOmitted: metadata.turnCount > turns.length,
        firstEventSeq: events[0]?.seq,
        lastEventSeq: recentEvents.events.at(-1)?.seq,
      },
    };
  }

  createSession(input: CreateSessionInput): SessionMetadata {
    this.ensureOpen();
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? this.now();
    const title = input.title ?? `New session - ${new Date(createdAt).toISOString()}`;
    const history = input.initialHistory ?? [];
    assertID(id, "session id");
    assertNonEmptyString(title, "title");
    assertWorkspace(input.workspace);
    assertModelRef(input.model);
    assertMode(input.mode);
    if (input.effort !== undefined) assertNonEmptyString(input.effort, "effort");
    assertTimestamp(createdAt, "createdAt");
    assertModelHistory(history);
    const historyJson = encodeJson(history, "model history");

    return this.transaction(() => {
      if (this.sessionRow(id)) invalid(`Session already exists: ${id}`);
      this.db.query<unknown, [string, string, string | null, string, string, string, string | null, number, number]>(`
        INSERT INTO sessions (
          id, title, workspace, provider_id, model_id, mode, effort, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        title,
        input.workspace,
        input.model.providerID,
        input.model.modelID,
        input.mode,
        input.effort ?? null,
        createdAt,
        createdAt,
      );
      this.db.query<unknown, [string, string, number]>(`
        INSERT INTO model_histories (session_id, history_json, updated_at) VALUES (?, ?, ?)
      `).run(id, historyJson, createdAt);
      return sessionFromRow(this.requireSessionRow(id));
    });
  }

  updateSession(id: string, patch: SessionUpdate, updatedAt = this.now()): SessionMetadata {
    this.ensureOpen();
    assertID(id, "session id");
    assertTimestamp(updatedAt, "updatedAt");
    const sets = ["updated_at = ?"];
    const values: SQLQueryBindings[] = [updatedAt];
    if (Object.hasOwn(patch, "title")) {
      assertNonEmptyString(patch.title, "title");
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (Object.hasOwn(patch, "workspace")) {
      assertWorkspace(patch.workspace);
      sets.push("workspace = ?");
      values.push(patch.workspace ?? null);
    }
    if (Object.hasOwn(patch, "model")) {
      assertModelRef(patch.model);
      sets.push("provider_id = ?", "model_id = ?");
      values.push(patch.model.providerID, patch.model.modelID);
    }
    if (Object.hasOwn(patch, "mode")) {
      assertMode(patch.mode);
      sets.push("mode = ?");
      values.push(patch.mode);
    }
    if (Object.hasOwn(patch, "effort")) {
      if (patch.effort !== null && patch.effort !== undefined) assertNonEmptyString(patch.effort, "effort");
      sets.push("effort = ?");
      values.push(patch.effort ?? null);
    }
    values.push(id);
    return this.transaction(() => {
      const current = this.requireSessionRow(id);
      if (updatedAt < current.created_at) invalid("updatedAt cannot precede createdAt");
      this.db.query<unknown, SQLQueryBindings[]>(`
        UPDATE sessions SET ${sets.join(", ")} WHERE id = ?
      `).run(...values);
      return sessionFromRow(this.requireSessionRow(id));
    });
  }

  deleteSession(id: string): boolean {
    this.ensureOpen();
    assertID(id, "session id");
    return this.db.query<unknown, [string]>("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
  }

  listTurns(sessionID: string): SessionTurn[] {
    this.ensureOpen();
    assertID(sessionID, "session id");
    const session = this.requireSessionRow(sessionID);
    return this.db.query<TurnRow, [string, number]>(`
      SELECT * FROM turns WHERE session_id = ? AND ordinal <= ? ORDER BY ordinal
    `).all(sessionID, session.turn_count).map(turnFromRow);
  }

  listRecentVisibleTurns(sessionID: string, limit: number): SessionTurnSummary[] {
    this.ensureOpen();
    assertID(sessionID, "session id");
    assertRecentLimit(limit, "turn limit");
    const session = this.requireSessionRow(sessionID);
    return this.db.query<TurnSummaryRow, [string, number, number]>(`
      SELECT id, session_id, ordinal, prompt, status, accepted_at, settled_at,
             finish_reason, error_message, boundary_seq
      FROM turns
      WHERE session_id = ? AND ordinal <= ?
      ORDER BY ordinal DESC
      LIMIT ?
    `).all(sessionID, session.turn_count, limit).reverse().map(turnSummaryFromRow);
  }

  acceptTurn(input: AcceptTurnInput): SessionTurn {
    this.ensureOpen();
    const turnID = input.turnID ?? randomUUID();
    const acceptedAt = input.acceptedAt ?? this.now();
    const rollbackData = input.rollbackData ?? null;
    assertID(input.sessionID, "session id");
    assertID(turnID, "turn id");
    assertNonEmptyString(input.prompt, "prompt");
    assertTimestamp(acceptedAt, "acceptedAt");
    assertJsonValue(rollbackData, "rollback data");

    return this.transaction(() => {
      const session = this.requireSessionRow(input.sessionID);
      if (acceptedAt < session.created_at) invalid("acceptedAt cannot precede the session");
      if (this.revertRow(input.sessionID)) {
        throw new SessionArchiveError(
          "REVISION_CONFLICT",
          `Session ${input.sessionID} has an active revert; commit it before accepting a turn`,
        );
      }
      const running = this.db.query<{ id: string }, [string]>(`
        SELECT id FROM turns WHERE session_id = ? AND status = 'running'
      `).get(input.sessionID);
      if (running) {
        throw new SessionArchiveError("BUSY", `Session ${input.sessionID} already has a running turn`);
      }
      if (this.turnRowByID(turnID)) invalid(`Turn already exists: ${turnID}`);
      const history = this.historyForSession(input.sessionID);
      const checkpoint: RollbackCheckpoint = { history, data: rollbackData };
      const checkpointJson = encodeJson(checkpoint, "rollback checkpoint");
      const ordinal = session.turn_count + 1;
      this.db.query<unknown, [string, string, number, string, number, number, string]>(`
        INSERT INTO turns (
          id, session_id, ordinal, prompt, status, accepted_at, boundary_seq, rollback_checkpoint_json
        ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)
      `).run(turnID, input.sessionID, ordinal, input.prompt, acceptedAt, session.next_event_seq, checkpointJson);
      this.db.query<unknown, [number, string]>(`
        UPDATE sessions SET turn_count = turn_count + 1, updated_at = ? WHERE id = ?
      `).run(acceptedAt, input.sessionID);
      return turnFromRow(this.requireTurnRow(input.sessionID, turnID));
    });
  }

  appendEvent(input: AppendEventInput): SessionEventRecord {
    this.ensureOpen();
    const at = input.at ?? this.now();
    assertID(input.sessionID, "session id");
    if (input.turnID !== undefined) assertID(input.turnID, "turn id");
    assertTimestamp(at, "event timestamp");
    assertSessionEvent(input.event);
    if (isTerminalEvent(input.event)) {
      invalid("Terminal events must be written with settleTurn");
    }
    const eventJson = encodeJson(input.event, "session event");
    return this.transaction(() => this.insertEvent(
      input.sessionID,
      input.turnID,
      at,
      input.event,
      eventJson,
      true,
    ));
  }

  listEvents(sessionID: string, afterSeq = 0): SessionEventRecord[] {
    this.ensureOpen();
    assertID(sessionID, "session id");
    assertNonNegativeInteger(afterSeq, "afterSeq");
    this.requireSessionRow(sessionID);
    return this.db.query<EventRow, [string, number]>(`
      SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq
    `).all(sessionID, afterSeq).map(eventFromRow);
  }

  listVisibleEvents(sessionID: string, afterSeq = 0): SessionEventRecord[] {
    this.ensureOpen();
    assertID(sessionID, "session id");
    assertNonNegativeInteger(afterSeq, "afterSeq");
    this.requireSessionRow(sessionID);
    const revert = this.revertRow(sessionID);
    if (!revert) return this.listEvents(sessionID, afterSeq);
    this.validateRevertRow(revert);
    return this.db.query<EventRow, [string, number, number]>(`
      SELECT * FROM events
      WHERE session_id = ? AND seq > ? AND seq < ?
      ORDER BY seq
    `).all(sessionID, afterSeq, revert.boundary_seq).map(eventFromRow);
  }

  settleTurn(input: SettleTurnInput): SettledTurn {
    this.ensureOpen();
    const settledAt = input.settledAt ?? this.now();
    assertID(input.sessionID, "session id");
    assertID(input.turnID, "turn id");
    assertTimestamp(settledAt, "settledAt");
    if (!["completed", "failed", "aborted"].includes(input.status)) invalid("Invalid terminal turn status");
    assertSessionEvent(input.terminalEvent, "terminal event");
    assertTerminalPair(input.status, input.terminalEvent);
    assertModelHistory(input.history);
    if (input.rollbackData !== undefined) assertJsonValue(input.rollbackData, "rollback data");
    const eventJson = encodeJson(input.terminalEvent, "terminal event");
    const historyJson = encodeJson(input.history, "model history");

    return this.transaction(() => {
      const row = this.requireTurnRow(input.sessionID, input.turnID);
      if (row.status !== "running") {
        throw new SessionArchiveError("INVALID", `Turn ${input.turnID} is already ${row.status}`);
      }
      if (settledAt < row.accepted_at) invalid("settledAt cannot precede acceptedAt");
      const event = this.insertEvent(
        input.sessionID,
        input.turnID,
        settledAt,
        input.terminalEvent,
        eventJson,
        true,
      );
      const finishReason = input.terminalEvent.type === "finish" ? input.terminalEvent.reason : null;
      const errorMessage = input.terminalEvent.type === "error" ? input.terminalEvent.message : null;
      const checkpoint = parseRollbackCheckpoint(row.rollback_checkpoint_json);
      const checkpointJson = input.rollbackData === undefined
        ? row.rollback_checkpoint_json
        : encodeJson({ history: checkpoint.history, data: input.rollbackData }, "rollback checkpoint");
      this.db.query<unknown, [string, number, string | null, string | null, string, string, string]>(`
        UPDATE turns
        SET status = ?, settled_at = ?, finish_reason = ?, error_message = ?, rollback_checkpoint_json = ?
        WHERE session_id = ? AND id = ?
      `).run(input.status, settledAt, finishReason, errorMessage, checkpointJson, input.sessionID, input.turnID);
      this.writeHistory(input.sessionID, historyJson, input.turnID, settledAt);
      this.db.query<unknown, [number, string]>(`
        UPDATE sessions SET updated_at = ? WHERE id = ?
      `).run(settledAt, input.sessionID);
      return {
        turn: turnFromRow(this.requireTurnRow(input.sessionID, input.turnID)),
        event,
      };
    });
  }

  getModelHistory(sessionID: string): ModelHistory {
    this.ensureOpen();
    assertID(sessionID, "session id");
    this.requireSessionRow(sessionID);
    return this.historyForSession(sessionID);
  }

  getDraft(sessionID: string): SessionDraft | undefined {
    this.ensureOpen();
    assertID(sessionID, "session id");
    this.requireSessionRow(sessionID);
    const row = this.db.query<DraftRow, [string]>(`
      SELECT * FROM drafts WHERE session_id = ? ORDER BY revision DESC LIMIT 1
    `).get(sessionID);
    return row ? draftFromRow(row) : undefined;
  }

  listDraftRevisions(sessionID: string): SessionDraft[] {
    this.ensureOpen();
    assertID(sessionID, "session id");
    this.requireSessionRow(sessionID);
    return this.db.query<DraftRow, [string]>(`
      SELECT * FROM drafts WHERE session_id = ? ORDER BY revision
    `).all(sessionID).map(draftFromRow);
  }

  saveDraft(input: SaveDraftInput): SessionDraft {
    this.ensureOpen();
    const createdAt = input.createdAt ?? this.now();
    assertID(input.sessionID, "session id");
    assertString(input.text, "draft text");
    assertTimestamp(createdAt, "draft timestamp");
    if (input.expectedRevision !== undefined) {
      assertNonNegativeInteger(input.expectedRevision, "expectedRevision");
    }
    return this.transaction(() => {
      this.requireSessionRow(input.sessionID);
      const latest = this.db.query<{ revision: number }, [string]>(`
        SELECT revision FROM drafts WHERE session_id = ? ORDER BY revision DESC LIMIT 1
      `).get(input.sessionID);
      const currentRevision = latest?.revision ?? 0;
      if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
        throw new SessionArchiveError(
          "REVISION_CONFLICT",
          `Expected draft revision ${input.expectedRevision}, found ${currentRevision}`,
        );
      }
      const revision = currentRevision + 1;
      this.db.query<unknown, [string, number, string, number]>(`
        INSERT INTO drafts (session_id, revision, text, created_at) VALUES (?, ?, ?, ?)
      `).run(input.sessionID, revision, input.text, createdAt);
      return draftFromRow(this.db.query<DraftRow, [string, number]>(`
        SELECT * FROM drafts WHERE session_id = ? AND revision = ?
      `).get(input.sessionID, revision)!);
    });
  }

  getRollbackCheckpoint(sessionID: string, turnID: string): RollbackCheckpoint {
    this.ensureOpen();
    assertID(sessionID, "session id");
    assertID(turnID, "turn id");
    return parseRollbackCheckpoint(this.requireTurnRow(sessionID, turnID).rollback_checkpoint_json);
  }

  updateInterruptedTurnRollback(
    sessionID: string,
    turnID: string,
    rollbackData: JsonValue,
  ): SessionTurn {
    this.ensureOpen();
    assertID(sessionID, "session id");
    assertID(turnID, "turn id");
    assertJsonValue(rollbackData, "rollback data");
    return this.transaction(() => {
      const row = this.requireTurnRow(sessionID, turnID);
      if (row.status !== "interrupted") {
        throw new SessionArchiveError("INVALID", `Turn ${turnID} is not interrupted`);
      }
      const checkpoint = parseRollbackCheckpoint(row.rollback_checkpoint_json);
      this.db.query<unknown, [string, string, string]>(`
        UPDATE turns SET rollback_checkpoint_json = ? WHERE session_id = ? AND id = ?
      `).run(
        encodeJson({ history: checkpoint.history, data: rollbackData }, "rollback checkpoint"),
        sessionID,
        turnID,
      );
      return turnFromRow(this.requireTurnRow(sessionID, turnID));
    });
  }

  recoverInterruptedTurns(at = this.now()): SessionTurn[] {
    this.ensureOpen();
    assertTimestamp(at, "recovery timestamp");
    const rows = this.db.query<TurnRow, []>(`
      SELECT * FROM turns WHERE status = 'running' ORDER BY session_id, ordinal
    `).all();
    if (rows.length === 0) return [];
    const terminalEvent: Extract<SessionEvent, { type: "finish" }> = { type: "finish", reason: "interrupted" };
    const eventJson = encodeJson(terminalEvent, "interrupted event");
    return this.transaction(() => rows.map((row) => {
      const settledAt = Math.max(at, row.accepted_at);
      this.insertEvent(row.session_id, row.id, settledAt, terminalEvent, eventJson, true);
      this.db.query<unknown, [number, string, string]>(`
        UPDATE turns
        SET status = 'interrupted', settled_at = ?, finish_reason = 'interrupted'
        WHERE session_id = ? AND id = ? AND status = 'running'
      `).run(settledAt, row.session_id, row.id);
      this.db.query<unknown, [number, number, string]>(`
        UPDATE sessions
        SET updated_at = CASE WHEN updated_at > ? THEN updated_at ELSE ? END
        WHERE id = ?
      `).run(settledAt, settledAt, row.session_id);
      return turnFromRow(this.requireTurnRow(row.session_id, row.id));
    }));
  }

  forkSession(sourceID: string, options: ForkSessionOptions = {}): SessionMetadata {
    return this.cloneSession(sourceID, undefined, options);
  }

  forkFromTurn(sourceID: string, turnID: string, options: ForkSessionOptions = {}): SessionMetadata {
    this.ensureOpen();
    assertID(sourceID, "source session id");
    assertID(turnID, "turn id");
    return this.cloneSession(sourceID, turnID, options);
  }

  getRevertState(sessionID: string): SessionRevertState | undefined {
    this.ensureOpen();
    assertID(sessionID, "session id");
    this.requireSessionRow(sessionID);
    const row = this.revertRow(sessionID);
    if (!row) return undefined;
    this.validateRevertRow(row);
    return revertStateFromRow(row);
  }

  undoToTurn(
    sessionID: string,
    turnID: string,
    options: RevertMutationOptions = {},
  ): SessionRevertState {
    this.ensureOpen();
    assertID(sessionID, "session id");
    assertID(turnID, "turn id");
    const { updatedAt, expectedRevision } = this.revertMutationOptions(options);
    return this.transaction(() => {
      const session = this.requireSessionRow(sessionID);
      this.assertNoRunningTurn(sessionID);
      const current = this.revertRow(sessionID);
      if (current) this.validateRevertRow(current);
      assertExpectedRevision(expectedRevision, current?.revision ?? 0);
      if (updatedAt < session.updated_at || updatedAt < (current?.created_at ?? session.created_at)) {
        invalid("updatedAt cannot precede the current session or revert cursor");
      }

      const target = this.requireTurnRow(sessionID, turnID);
      if (target.status === "running" || target.settled_at === null) {
        throw new SessionArchiveError("BUSY", `Turn ${turnID} is still running`);
      }
      if (target.ordinal > session.turn_count || (current && target.ordinal >= current.boundary_ordinal)) {
        throw new SessionArchiveError("REVISION_CONFLICT", `Turn ${turnID} is not visible at the current cursor`);
      }
      const checkpoint = parseRollbackCheckpoint(target.rollback_checkpoint_json);
      const previous = this.turnRowByOrdinal(sessionID, target.ordinal - 1);
      const historyJson = encodeJson(checkpoint.history, "model history");
      const rollbackDataJson = encodeJson(checkpoint.data, "rollback data");

      if (current) {
        this.db.query<unknown, [number, string, number, number, string, number, string]>(`
          UPDATE session_reverts
          SET revision = ?, boundary_turn_id = ?, boundary_ordinal = ?, boundary_seq = ?,
              rollback_data_json = ?, updated_at = ?
          WHERE session_id = ?
        `).run(
          current.revision + 1,
          target.id,
          target.ordinal,
          target.boundary_seq,
          rollbackDataJson,
          updatedAt,
          sessionID,
        );
      } else {
        const originalHistory = this.requireHistoryRow(sessionID);
        this.db.query<unknown, [string, number, string, number, number, number, string, string | null, string, number, number]>(`
          INSERT INTO session_reverts (
            session_id, revision, boundary_turn_id, boundary_ordinal, boundary_seq,
            original_turn_count, original_history_json, original_through_turn_id,
            rollback_data_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          sessionID,
          1,
          target.id,
          target.ordinal,
          target.boundary_seq,
          session.turn_count,
          originalHistory.history_json,
          originalHistory.through_turn_id,
          rollbackDataJson,
          updatedAt,
          updatedAt,
        );
      }
      this.writeHistory(sessionID, historyJson, previous?.id ?? null, updatedAt);
      this.db.query<unknown, [number, number, string]>(`
        UPDATE sessions SET turn_count = ?, updated_at = ? WHERE id = ?
      `).run(target.ordinal - 1, updatedAt, sessionID);
      const row = this.requireRevertRow(sessionID);
      this.validateRevertRow(row);
      return revertStateFromRow(row);
    });
  }

  redoTurn(sessionID: string, options: RevertMutationOptions = {}): SessionRevertState | undefined {
    this.ensureOpen();
    assertID(sessionID, "session id");
    const { updatedAt, expectedRevision } = this.revertMutationOptions(options);
    return this.transaction(() => {
      const session = this.requireSessionRow(sessionID);
      this.assertNoRunningTurn(sessionID);
      const current = this.requireRevertRow(sessionID);
      this.validateRevertRow(current);
      assertExpectedRevision(expectedRevision, current.revision);
      if (updatedAt < session.updated_at || updatedAt < current.created_at) {
        invalid("updatedAt cannot precede the current session or revert cursor");
      }
      const target = this.requireTurnRow(sessionID, current.boundary_turn_id);

      if (current.boundary_ordinal === current.original_turn_count) {
        this.writeHistory(
          sessionID,
          current.original_history_json,
          current.original_through_turn_id,
          updatedAt,
        );
        this.db.query<unknown, [number, number, string]>(`
          UPDATE sessions SET turn_count = ?, updated_at = ? WHERE id = ?
        `).run(current.original_turn_count, updatedAt, sessionID);
        this.db.query<unknown, [string]>("DELETE FROM session_reverts WHERE session_id = ?").run(sessionID);
        return undefined;
      }

      const next = this.turnRowByOrdinal(sessionID, current.boundary_ordinal + 1);
      if (!next || next.ordinal > current.original_turn_count) {
        corrupt(`Session ${sessionID} has an invalid redo boundary`);
      }
      const checkpoint = parseRollbackCheckpoint(next.rollback_checkpoint_json);
      this.writeHistory(
        sessionID,
        encodeJson(checkpoint.history, "model history"),
        target.id,
        updatedAt,
      );
      this.db.query<unknown, [number, number, string]>(`
        UPDATE sessions SET turn_count = ?, updated_at = ? WHERE id = ?
      `).run(current.boundary_ordinal, updatedAt, sessionID);
      this.db.query<unknown, [number, string, number, number, string, number, string]>(`
        UPDATE session_reverts
        SET revision = ?, boundary_turn_id = ?, boundary_ordinal = ?, boundary_seq = ?,
            rollback_data_json = ?, updated_at = ?
        WHERE session_id = ?
      `).run(
        current.revision + 1,
        next.id,
        next.ordinal,
        next.boundary_seq,
        encodeJson(checkpoint.data, "rollback data"),
        updatedAt,
        sessionID,
      );
      const row = this.requireRevertRow(sessionID);
      this.validateRevertRow(row);
      return revertStateFromRow(row);
    });
  }

  commitRevert(sessionID: string, options: RevertMutationOptions = {}): SessionMetadata {
    this.ensureOpen();
    assertID(sessionID, "session id");
    const { updatedAt, expectedRevision } = this.revertMutationOptions(options);
    return this.transaction(() => {
      const session = this.requireSessionRow(sessionID);
      this.assertNoRunningTurn(sessionID);
      const current = this.requireRevertRow(sessionID);
      this.validateRevertRow(current);
      assertExpectedRevision(expectedRevision, current.revision);
      if (updatedAt < session.updated_at || updatedAt < current.created_at) {
        invalid("updatedAt cannot precede the current session or revert cursor");
      }

      this.db.query<unknown, [string, number]>(`
        DELETE FROM events WHERE session_id = ? AND seq >= ?
      `).run(sessionID, current.boundary_seq);
      this.db.query<unknown, [string, number]>(`
        DELETE FROM turns WHERE session_id = ? AND ordinal >= ?
      `).run(sessionID, current.boundary_ordinal);
      this.db.query<unknown, [string]>("DELETE FROM session_reverts WHERE session_id = ?").run(sessionID);
      this.db.query<unknown, [number, string]>(`
        UPDATE sessions SET updated_at = ? WHERE id = ?
      `).run(updatedAt, sessionID);
      return sessionFromRow(this.requireSessionRow(sessionID));
    });
  }

  getRevertBoundary(sessionID: string, turnID: string): RevertBoundary {
    this.ensureOpen();
    assertID(sessionID, "session id");
    assertID(turnID, "turn id");
    const session = this.requireSessionRow(sessionID);
    const turn = this.requireTurnRow(sessionID, turnID);
    if (turn.ordinal > session.turn_count) {
      throw new SessionArchiveError("REVISION_CONFLICT", `Turn ${turnID} is hidden by the revert cursor`);
    }
    const previous = this.db.query<{ id: string }, [string, number]>(`
      SELECT id FROM turns WHERE session_id = ? AND ordinal = ?
    `).get(sessionID, turn.ordinal - 1);
    return {
      sessionID,
      turnID,
      turnOrdinal: turn.ordinal,
      eventSeq: turn.boundary_seq,
      previousTurnID: previous?.id,
      checkpoint: parseRollbackCheckpoint(turn.rollback_checkpoint_json),
    };
  }

  revertToBoundary(boundary: RevertBoundary, updatedAt = this.now()): SessionMetadata {
    this.ensureOpen();
    assertID(boundary.sessionID, "session id");
    assertID(boundary.turnID, "turn id");
    assertNonNegativeInteger(boundary.turnOrdinal, "turn ordinal");
    assertNonNegativeInteger(boundary.eventSeq, "event sequence");
    if (boundary.previousTurnID !== undefined) assertID(boundary.previousTurnID, "previous turn id");
    assertRollbackCheckpoint(boundary.checkpoint);
    assertTimestamp(updatedAt, "updatedAt");
    return this.transaction(() => {
      const session = this.requireSessionRow(boundary.sessionID);
      if (this.revertRow(boundary.sessionID)) {
        throw new SessionArchiveError("REVISION_CONFLICT", "Commit the active revert before truncating");
      }
      this.assertNoRunningTurn(boundary.sessionID);
      if (updatedAt < session.created_at) invalid("updatedAt cannot precede the session");
      const target = this.requireTurnRow(boundary.sessionID, boundary.turnID);
      if (target.ordinal !== boundary.turnOrdinal || target.boundary_seq !== boundary.eventSeq) {
        throw new SessionArchiveError("REVISION_CONFLICT", "The conversation boundary is stale");
      }
      const storedCheckpoint = parseRollbackCheckpoint(target.rollback_checkpoint_json);
      const previous = this.db.query<{ id: string }, [string, number]>(`
        SELECT id FROM turns WHERE session_id = ? AND ordinal = ?
      `).get(boundary.sessionID, target.ordinal - 1);
      if (previous?.id !== boundary.previousTurnID) {
        throw new SessionArchiveError("REVISION_CONFLICT", "The conversation boundary is stale");
      }
      this.db.query<unknown, [string, number]>(`
        DELETE FROM events WHERE session_id = ? AND seq >= ?
      `).run(boundary.sessionID, target.boundary_seq);
      this.db.query<unknown, [string, number]>(`
        DELETE FROM turns WHERE session_id = ? AND ordinal >= ?
      `).run(boundary.sessionID, target.ordinal);
      this.writeHistory(
        boundary.sessionID,
        encodeJson(storedCheckpoint.history, "model history"),
        previous?.id ?? null,
        updatedAt,
      );
      this.db.query<unknown, [number, number, string]>(`
        UPDATE sessions SET turn_count = ?, updated_at = ? WHERE id = ?
      `).run(target.ordinal - 1, updatedAt, boundary.sessionID);
      return sessionFromRow(this.requireSessionRow(boundary.sessionID));
    });
  }

  flush(): void {
    this.ensureOpen();
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close(): void {
    if (this.closed) return;
    let failure: unknown;
    let failed = false;
    try {
      this.flush();
    } catch (error) {
      failure = error;
      failed = true;
    }
    this.closed = true;
    try {
      this.db.close();
    } catch (error) {
      if (!failed) {
        failure = error;
        failed = true;
      }
    }
    try {
      this.leaseDb?.close();
    } catch (error) {
      if (!failed) {
        failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;
  }

  private cloneSession(sourceID: string, fromTurnID: string | undefined, options: ForkSessionOptions): SessionMetadata {
    this.ensureOpen();
    assertID(sourceID, "source session id");
    const destinationID = options.id ?? randomUUID();
    const createdAt = options.createdAt ?? this.now();
    assertID(destinationID, "fork session id");
    assertTimestamp(createdAt, "fork createdAt");
    if (options.title !== undefined) assertNonEmptyString(options.title, "fork title");

    return this.transaction(() => {
      const source = this.requireSessionRow(sourceID);
      if (createdAt < source.created_at) invalid("fork createdAt cannot precede the source session");
      if (this.sessionRow(destinationID)) invalid(`Session already exists: ${destinationID}`);

      let turnLimit = source.turn_count;
      const sourceRevert = this.revertRow(sourceID);
      if (sourceRevert) this.validateRevertRow(sourceRevert);
      let eventLimit: number | undefined = sourceRevert?.boundary_seq;
      let history = this.requireHistoryRow(sourceID);
      let throughSourceTurnID = history.through_turn_id;
      if (fromTurnID === undefined) {
        const running = this.db.query<{ id: string }, [string]>(`
          SELECT id FROM turns WHERE session_id = ? AND status = 'running'
        `).get(sourceID);
        if (running) throw new SessionArchiveError("BUSY", "A running session cannot be fully forked");
      } else {
        const target = this.requireTurnRow(sourceID, fromTurnID);
        if (target.ordinal > source.turn_count) {
          throw new SessionArchiveError("REVISION_CONFLICT", `Turn ${fromTurnID} is hidden by the revert cursor`);
        }
        const checkpoint = parseRollbackCheckpoint(target.rollback_checkpoint_json);
        turnLimit = target.ordinal - 1;
        eventLimit = target.boundary_seq;
        const previous = this.db.query<{ id: string }, [string, number]>(`
          SELECT id FROM turns WHERE session_id = ? AND ordinal = ?
        `).get(sourceID, target.ordinal - 1);
        throughSourceTurnID = previous?.id ?? null;
        history = {
          history_json: encodeJson(checkpoint.history, "model history"),
          through_turn_id: throughSourceTurnID,
          updated_at: createdAt,
        };
      }

      const title = options.title ?? `${source.title} (fork)`;
      const sourceTurns = this.db.query<TurnRow, [string, number]>(`
        SELECT * FROM turns WHERE session_id = ? AND ordinal <= ? ORDER BY ordinal
      `).all(sourceID, turnLimit);
      const sourceEvents = eventLimit === undefined
        ? this.db.query<EventRow, [string]>(`
            SELECT * FROM events WHERE session_id = ? ORDER BY seq
          `).all(sourceID)
        : this.db.query<EventRow, [string, number]>(`
            SELECT * FROM events WHERE session_id = ? AND seq < ? ORDER BY seq
          `).all(sourceID, eventLimit);
      const nextEventSeq = (sourceEvents.at(-1)?.seq ?? 0) + 1;

      this.db.query<unknown, [string, string, string | null, string, string, string, string | null, number, number, number, number]>(`
        INSERT INTO sessions (
          id, title, workspace, provider_id, model_id, mode, effort,
          created_at, updated_at, turn_count, next_event_seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        destinationID,
        title,
        source.workspace,
        source.provider_id,
        source.model_id,
        source.mode,
        source.effort,
        createdAt,
        createdAt,
        turnLimit,
        nextEventSeq,
      );

      const turnIDs = new Map<string, string>();
      for (const turn of sourceTurns) {
        if (turn.status === "running") {
          throw new SessionArchiveError("CORRUPT", "A fork prefix contains a running turn");
        }
        const forkTurnID = randomUUID();
        turnIDs.set(turn.id, forkTurnID);
        this.db.query<unknown, [string, string, number, string, string, number, number | null, string | null, string | null, number, string]>(`
          INSERT INTO turns (
            id, session_id, ordinal, prompt, status, accepted_at, settled_at,
            finish_reason, error_message, boundary_seq, rollback_checkpoint_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          forkTurnID,
          destinationID,
          turn.ordinal,
          turn.prompt,
          turn.status,
          turn.accepted_at,
          turn.settled_at,
          turn.finish_reason,
          turn.error_message,
          turn.boundary_seq,
          turn.rollback_checkpoint_json,
        );
      }
      for (const event of sourceEvents) {
        const forkTurnID = event.turn_id === null ? null : turnIDs.get(event.turn_id);
        if (event.turn_id !== null && !forkTurnID) {
          throw new SessionArchiveError("CORRUPT", `Event ${event.seq} crosses the fork boundary`);
        }
        this.db.query<unknown, [string, number, string | null, number, string, string]>(`
          INSERT INTO events (session_id, seq, turn_id, at, event_type, event_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(destinationID, event.seq, forkTurnID ?? null, event.at, event.event_type, event.event_json);
      }
      const throughTurnID = throughSourceTurnID === null ? null : turnIDs.get(throughSourceTurnID);
      if (throughSourceTurnID !== null && !throughTurnID) {
        throw new SessionArchiveError("CORRUPT", "Model history crosses the fork boundary");
      }
      this.writeHistory(destinationID, history.history_json, throughTurnID ?? null, createdAt);
      return sessionFromRow(this.requireSessionRow(destinationID));
    });
  }

  private insertEvent(
    sessionID: string,
    turnID: string | undefined,
    at: number,
    event: SessionEvent,
    eventJson: string,
    requireRunningTurn: boolean,
  ): SessionEventRecord {
    const session = this.requireSessionRow(sessionID);
    if (at < session.created_at) invalid("Event timestamp cannot precede the session");
    if (turnID !== undefined) {
      const turn = this.requireTurnRow(sessionID, turnID);
      if (requireRunningTurn && turn.status !== "running") {
        throw new SessionArchiveError("INVALID", `Cannot append to ${turn.status} turn ${turnID}`);
      }
      if (at < turn.accepted_at) invalid("Event timestamp cannot precede its turn");
    }
    const seq = session.next_event_seq;
    this.db.query<unknown, [string, number, string | null, number, string, string]>(`
      INSERT INTO events (session_id, seq, turn_id, at, event_type, event_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionID, seq, turnID ?? null, at, event.type, eventJson);
    this.db.query<unknown, [string]>(`
      UPDATE sessions SET next_event_seq = next_event_seq + 1 WHERE id = ?
    `).run(sessionID);
    return { sessionID, seq, at, turnID, event };
  }

  private writeHistory(sessionID: string, historyJson: string, throughTurnID: string | null, updatedAt: number): void {
    this.db.query<unknown, [string, string, string | null, number]>(`
      INSERT INTO model_histories (session_id, history_json, through_turn_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        history_json = excluded.history_json,
        through_turn_id = excluded.through_turn_id,
        updated_at = excluded.updated_at
    `).run(sessionID, historyJson, throughTurnID, updatedAt);
  }

  private historyForSession(sessionID: string): ModelHistory {
    return parseModelHistory(this.requireHistoryRow(sessionID).history_json);
  }

  private recentVisibleEvents(
    sessionID: string,
    limit: number,
  ): { events: SessionEventRecord[]; omitted: boolean } {
    const revert = this.revertRow(sessionID);
    if (revert) this.validateRevertRow(revert);
    const rows = revert
      ? this.db.query<EventRow, [string, number, number]>(`
          SELECT * FROM events
          WHERE session_id = ? AND seq < ?
          ORDER BY seq DESC
          LIMIT ?
        `).all(sessionID, revert.boundary_seq, limit + 1)
      : this.db.query<EventRow, [string, number]>(`
          SELECT * FROM events
          WHERE session_id = ?
          ORDER BY seq DESC
          LIMIT ?
        `).all(sessionID, limit + 1);
    return {
      events: rows.slice(0, limit).reverse().map(eventFromRow),
      omitted: rows.length > limit,
    };
  }

  private revertMutationOptions(options: RevertMutationOptions): {
    updatedAt: number;
    expectedRevision: number | undefined;
  } {
    assertInputKeys(options, ["updatedAt", "expectedRevision"], "revert options");
    const updatedAt = options.updatedAt ?? this.now();
    assertTimestamp(updatedAt, "updatedAt");
    if (options.expectedRevision !== undefined) {
      assertNonNegativeInteger(options.expectedRevision, "expectedRevision");
    }
    return { updatedAt, expectedRevision: options.expectedRevision };
  }

  private assertNoRunningTurn(sessionID: string): void {
    const running = this.db.query<{ id: string }, [string]>(`
      SELECT id FROM turns WHERE session_id = ? AND status = 'running'
    `).get(sessionID);
    if (running) throw new SessionArchiveError("BUSY", `Session ${sessionID} has a running turn`);
  }

  private revertRow(sessionID: string): RevertRow | undefined {
    return this.db.query<RevertRow, [string]>(`
      SELECT * FROM session_reverts WHERE session_id = ?
    `).get(sessionID) ?? undefined;
  }

  private requireRevertRow(sessionID: string): RevertRow {
    const row = this.revertRow(sessionID);
    if (!row) throw new SessionArchiveError("INVALID", `Session ${sessionID} has no active revert`);
    return row;
  }

  private validateRevertRow(row: RevertRow): void {
    const session = this.requireSessionRow(row.session_id);
    const target = this.requireTurnRow(row.session_id, row.boundary_turn_id);
    const physical = this.db.query<{ count: number; max_ordinal: number | null }, [string]>(`
      SELECT count(*) AS count, max(ordinal) AS max_ordinal FROM turns WHERE session_id = ?
    `).get(row.session_id);
    if (
      !Number.isSafeInteger(row.revision)
      || row.revision < 1
      || !Number.isSafeInteger(row.boundary_ordinal)
      || !Number.isSafeInteger(row.boundary_seq)
      || !Number.isSafeInteger(row.original_turn_count)
      || row.original_turn_count < row.boundary_ordinal
      || target.ordinal !== row.boundary_ordinal
      || target.boundary_seq !== row.boundary_seq
      || target.status === "running"
      || target.settled_at === null
      || session.turn_count !== row.boundary_ordinal - 1
      || physical?.count !== row.original_turn_count
      || physical.max_ordinal !== row.original_turn_count
    ) {
      corrupt(`Session ${row.session_id} has an invalid revert cursor`);
    }
    parseModelHistory(row.original_history_json, "original model history");
    parseJson(row.rollback_data_json, "revert rollback data");
    if (row.original_through_turn_id !== null) {
      const through = this.requireTurnRow(row.session_id, row.original_through_turn_id);
      if (through.ordinal > row.original_turn_count) {
        corrupt(`Session ${row.session_id} has an invalid original history boundary`);
      }
    }
  }

  private sessionRow(id: string): SessionRow | undefined {
    return this.db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id) ?? undefined;
  }

  private requireSessionRow(id: string): SessionRow {
    const row = this.sessionRow(id);
    if (!row) throw new SessionArchiveError("NOT_FOUND", `Unknown session: ${id}`);
    return row;
  }

  private turnRowByID(id: string): TurnRow | undefined {
    return this.db.query<TurnRow, [string]>("SELECT * FROM turns WHERE id = ?").get(id) ?? undefined;
  }

  private turnRowByOrdinal(sessionID: string, ordinal: number): TurnRow | undefined {
    if (ordinal < 1) return undefined;
    return this.db.query<TurnRow, [string, number]>(`
      SELECT * FROM turns WHERE session_id = ? AND ordinal = ?
    `).get(sessionID, ordinal) ?? undefined;
  }

  private requireTurnRow(sessionID: string, turnID: string): TurnRow {
    const row = this.db.query<TurnRow, [string, string]>(`
      SELECT * FROM turns WHERE session_id = ? AND id = ?
    `).get(sessionID, turnID);
    if (!row) throw new SessionArchiveError("NOT_FOUND", `Unknown turn ${turnID} in session ${sessionID}`);
    return row;
  }

  private requireHistoryRow(sessionID: string): HistoryRow {
    const row = this.db.query<HistoryRow, [string]>(`
      SELECT history_json, through_turn_id, updated_at FROM model_histories WHERE session_id = ?
    `).get(sessionID);
    if (!row) throw new SessionArchiveError("CORRUPT", `Session ${sessionID} has no model history`);
    return row;
  }

  private migrate(): void {
    const row = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get();
    const current = row?.user_version ?? 0;
    if (current > SESSION_SCHEMA_VERSION) {
      throw new SessionArchiveError(
        "UNSUPPORTED_SCHEMA",
        `Session archive schema ${current} is newer than supported schema ${SESSION_SCHEMA_VERSION}`,
      );
    }
    for (let version = current; version < SESSION_SCHEMA_VERSION; version += 1) {
      const sql = MIGRATIONS[version];
      if (!sql) throw new SessionArchiveError("UNSUPPORTED_SCHEMA", `Missing migration to schema ${version + 1}`);
      this.transaction(() => {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${version + 1}`);
      });
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new SessionArchiveError("CLOSED", "Session archive is closed");
  }
}

function sessionFromRow(row: SessionRow): SessionMetadata {
  if (
    typeof row.id !== "string"
    || typeof row.title !== "string"
    || (row.workspace !== null && typeof row.workspace !== "string")
    || typeof row.provider_id !== "string"
    || typeof row.model_id !== "string"
    || (row.mode !== "build" && row.mode !== "plan")
    || (row.effort !== null && typeof row.effort !== "string")
    || !Number.isSafeInteger(row.created_at)
    || !Number.isSafeInteger(row.updated_at)
    || !Number.isSafeInteger(row.turn_count)
  ) {
    corrupt("Stored session metadata is invalid");
  }
  return {
    id: row.id,
    title: row.title,
    workspace: row.workspace,
    model: { providerID: row.provider_id, modelID: row.model_id },
    mode: row.mode,
    effort: row.effort ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turnCount: row.turn_count,
  };
}

function turnFromRow(row: TurnRow): SessionTurn {
  if (!isTurnStatus(row.status)) corrupt(`Stored turn ${row.id} has an invalid status`);
  const checkpoint = parseRollbackCheckpoint(row.rollback_checkpoint_json);
  return {
    id: row.id,
    sessionID: row.session_id,
    ordinal: row.ordinal,
    prompt: row.prompt,
    status: row.status,
    acceptedAt: row.accepted_at,
    settledAt: row.settled_at ?? undefined,
    finishReason: row.finish_reason ?? undefined,
    errorMessage: row.error_message ?? undefined,
    boundarySeq: row.boundary_seq,
    checkpoint,
  };
}

function turnSummaryFromRow(row: TurnSummaryRow): SessionTurnSummary {
  if (!isTurnStatus(row.status)) corrupt(`Stored turn ${row.id} has an invalid status`);
  return {
    id: row.id,
    sessionID: row.session_id,
    ordinal: row.ordinal,
    prompt: row.prompt,
    status: row.status,
    acceptedAt: row.accepted_at,
    settledAt: row.settled_at ?? undefined,
    finishReason: row.finish_reason ?? undefined,
    errorMessage: row.error_message ?? undefined,
    boundarySeq: row.boundary_seq,
  };
}

function eventFromRow(row: EventRow): SessionEventRecord {
  const event = parseSessionEvent(row.event_json);
  if (event.type !== row.event_type) corrupt(`Stored event ${row.seq} has mismatched type metadata`);
  return {
    sessionID: row.session_id,
    seq: row.seq,
    at: row.at,
    turnID: row.turn_id ?? undefined,
    event,
  };
}

function draftFromRow(row: DraftRow): SessionDraft {
  return {
    sessionID: row.session_id,
    revision: row.revision,
    text: row.text,
    createdAt: row.created_at,
  };
}

function revertStateFromRow(row: RevertRow): SessionRevertState {
  return {
    sessionID: row.session_id,
    revision: row.revision,
    boundaryTurnID: row.boundary_turn_id,
    boundaryOrdinal: row.boundary_ordinal,
    boundarySeq: row.boundary_seq,
    visibleTurnCount: row.boundary_ordinal - 1,
    originalTurnCount: row.original_turn_count,
    originalHistory: parseModelHistory(row.original_history_json, "original model history"),
    rollbackData: parseJson(row.rollback_data_json, "revert rollback data"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertWorkspace(value: unknown): asserts value is string | null {
  if (value !== null) assertNonEmptyString(value, "workspace");
}

function assertRecentLimit(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || value === Number.MAX_SAFE_INTEGER) {
    invalid(`${label} must be a positive safe integer`);
  }
}

function assertTerminalPair(status: SettleTurnInput["status"], event: SessionEvent): void {
  if (!isTerminalEvent(event)) invalid("settleTurn requires a finish or error event");
  if (status === "failed" && event.type !== "error") invalid("Failed turns require an error event");
  if (status !== "failed" && event.type !== "finish") invalid(`${status} turns require a finish event`);
}

function isTerminalEvent(event: SessionEvent): event is Extract<SessionEvent, { type: "finish" | "error" }> {
  return event.type === "finish" || event.type === "error";
}

function isTurnStatus(value: string): value is TurnStatus {
  return ["running", "completed", "failed", "aborted", "interrupted"].includes(value);
}

function isMemoryFilename(filename: string): boolean {
  return filename === ":memory:" || filename === "" || filename.startsWith("file::memory:");
}

function acquireFileLease(filename: string): Database {
  let leaseDb: Database | undefined;
  try {
    leaseDb = new Database(`${filename}.lock`, { create: true, readwrite: true, strict: true });
    leaseDb.exec("PRAGMA busy_timeout = 0");
    leaseDb.exec("BEGIN IMMEDIATE");
    return leaseDb;
  } catch (error) {
    closeIgnoringErrors(leaseDb);
    if (isSQLiteBusy(error)) {
      throw new SessionArchiveError("BUSY", `Session archive is already open: ${filename}`, { cause: error });
    }
    throw error;
  }
}

function closeIgnoringErrors(db: Database | undefined): void {
  try {
    db?.close();
  } catch {
    // Preserve the constructor failure while still attempting every cleanup.
  }
}

function isSQLiteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const sqliteError = error as { code?: unknown; errno?: unknown };
  return (
    (typeof sqliteError.code === "string" && sqliteError.code.startsWith("SQLITE_BUSY"))
    || sqliteError.errno === 5
  );
}

function assertInputKeys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) invalid(`${label}.${key} is not supported`);
  }
}

function assertExpectedRevision(expected: number | undefined, actual: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new SessionArchiveError(
      "REVISION_CONFLICT",
      `Expected revert revision ${expected}, found ${actual}`,
    );
  }
}

function invalid(message: string): never {
  throw new SessionArchiveError("INVALID", message);
}

function corrupt(message: string): never {
  throw new SessionArchiveError("CORRUPT", message);
}
