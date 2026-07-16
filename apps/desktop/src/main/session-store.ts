import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ModelMessage } from "@cozycode/core";
import type { ModelRef, SessionEvent } from "@cozycode/protocol";
import type { PermissionPreset, SessionMeta, SessionRecord } from "../shared/ipc.ts";

type LegacySession = Omit<SessionMeta, "model"> & { model: ModelRef | string };

interface LegacyIndexFile {
  sessions?: LegacySession[];
}

interface SessionRow {
  id: string;
  title: string;
  title_edited: number;
  created_at: number;
  updated_at: number;
  workspace_root: string | null;
  provider_id: string;
  model_id: string;
  preset: PermissionPreset;
  message_count: number;
  parent_id: string | null;
  agent: string | null;
}

interface RecordRow {
  at: number;
  kind: "user" | "event";
  payload_json: string;
}

const LEGACY_MIGRATION_KEY = "legacy_import_v1";

class RetryLegacyMigrationError extends Error {}

/** SQLite-backed session archive. All calls run on Electron's main thread. */
export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly legacyProviderID: string;
  private readonly deltaBuffers = new Map<string, string>();
  private readonly deltaTimers = new Map<string, NodeJS.Timeout>();
  private readonly insertRecord: StatementSync;

  constructor(dir: string, legacyProviderID = "openai") {
    this.legacyProviderID = legacyProviderID;
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, "sessions.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        title_edited INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        workspace_root TEXT,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        preset TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        parent_id TEXT,
        agent TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS records (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('user', 'event')),
        payload_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS records_session_idx ON records(session_id, seq);
      CREATE TABLE IF NOT EXISTS histories (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        messages_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
    `);
    this.insertRecord = this.db.prepare(
      "INSERT INTO records (session_id, at, kind, payload_json) VALUES (?, ?, ?, ?)",
    );
    this.migrateLegacy(dir);
  }

  async list(): Promise<SessionMeta[]> {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as unknown as SessionRow[];
    return rows.map(sessionFromRow);
  }

  async get(id: string): Promise<SessionMeta | undefined> {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  async create(opts: {
    workspaceRoot: string | null;
    model: ModelRef;
    preset: PermissionPreset;
    now: number;
    title?: string;
    id?: string;
    parentID?: string | null;
    agent?: string;
  }): Promise<SessionMeta> {
    const meta: SessionMeta = {
      id: opts.id ?? randomUUID(),
      title: opts.title ?? `New session - ${new Date(opts.now).toISOString()}`,
      titleEdited: Boolean(opts.title),
      createdAt: opts.now,
      updatedAt: opts.now,
      workspaceRoot: opts.workspaceRoot,
      model: opts.model,
      preset: opts.preset,
      messageCount: 0,
      parentID: opts.parentID ?? null,
      agent: opts.agent,
    };
    this.insertSession(meta);
    return meta;
  }

  async rename(id: string, title: string): Promise<void> {
    this.db.prepare("UPDATE sessions SET title = ?, title_edited = 1 WHERE id = ?").run(title, id);
  }

  async touch(id: string, patch: Partial<SessionMeta>): Promise<void> {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const add = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (Object.hasOwn(patch, "title")) add("title", patch.title!);
    if (Object.hasOwn(patch, "titleEdited")) add("title_edited", patch.titleEdited ? 1 : 0);
    if (Object.hasOwn(patch, "createdAt")) add("created_at", patch.createdAt!);
    if (Object.hasOwn(patch, "updatedAt")) add("updated_at", patch.updatedAt!);
    if (Object.hasOwn(patch, "workspaceRoot")) add("workspace_root", patch.workspaceRoot ?? null);
    if (Object.hasOwn(patch, "model") && patch.model) {
      add("provider_id", patch.model.providerID);
      add("model_id", patch.model.modelID);
    }
    if (Object.hasOwn(patch, "preset")) add("preset", patch.preset!);
    if (Object.hasOwn(patch, "messageCount")) add("message_count", patch.messageCount!);
    if (Object.hasOwn(patch, "parentID")) add("parent_id", patch.parentID ?? null);
    if (Object.hasOwn(patch, "agent")) add("agent", patch.agent ?? null);
    if (!sets.length) return;
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  async remove(id: string): Promise<void> {
    this.flushDeltas(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  appendUser(id: string, text: string): void {
    this.flushDeltas(id);
    this.insertRecord.run(id, Date.now(), "user", JSON.stringify(text));
  }

  /** Persist an accepted user turn and its list metadata atomically. */
  appendUserTurn(id: string, text: string, updatedAt: number): number {
    this.flushDeltas(id);
    return this.transaction(() => {
      this.insertRecord.run(id, updatedAt, "user", JSON.stringify(text));
      this.db.prepare(`
        UPDATE sessions
        SET message_count = message_count + 1, updated_at = ?
        WHERE id = ?
      `).run(updatedAt, id);
      const row = this.db.prepare("SELECT message_count FROM sessions WHERE id = ?").get(id) as
        | { message_count: number }
        | undefined;
      if (!row) throw new Error(`Unknown session: ${id}`);
      return row.message_count;
    });
  }

  appendEvent(id: string, event: SessionEvent): void {
    if (event.type === "text-delta") {
      this.deltaBuffers.set(id, (this.deltaBuffers.get(id) ?? "") + event.text);
      if ((this.deltaBuffers.get(id)?.length ?? 0) >= 4096) this.flushDeltas(id);
      else if (!this.deltaTimers.has(id)) {
        const timer = setTimeout(() => this.flushDeltas(id), 250);
        timer.unref();
        this.deltaTimers.set(id, timer);
      }
      return;
    }
    this.flushDeltas(id);
    this.insertRecord.run(id, Date.now(), "event", JSON.stringify(event));
  }

  async readRecords(id: string): Promise<SessionRecord[]> {
    this.flushDeltas(id);
    const rows = this.db
      .prepare("SELECT at, kind, payload_json FROM records WHERE session_id = ? ORDER BY seq")
      .all(id) as unknown as RecordRow[];
    const records = rows.flatMap((row): SessionRecord[] => {
      try {
        return row.kind === "user"
          ? [{ at: row.at, kind: "user", text: JSON.parse(row.payload_json) as string }]
          : [{ at: row.at, kind: "event", event: JSON.parse(row.payload_json) as SessionEvent }];
      } catch {
        return [];
      }
    });
    const last = records.at(-1);
    const lastEvent = last?.kind === "event" ? last.event.type : undefined;
    if (records.length && lastEvent !== "finish" && lastEvent !== "error") {
      records.push({ at: Date.now(), kind: "event", event: { type: "finish", reason: "interrupted" } });
    }
    return records;
  }

  async readHistory(id: string): Promise<ModelMessage[] | undefined> {
    const row = this.db.prepare("SELECT messages_json FROM histories WHERE session_id = ?").get(id) as
      | { messages_json: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.messages_json) as ModelMessage[];
    } catch {
      return undefined;
    }
  }

  async writeHistory(id: string, messages: ModelMessage[]): Promise<void> {
    this.db.prepare(`
      INSERT INTO histories (session_id, messages_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        messages_json = excluded.messages_json,
        updated_at = excluded.updated_at
    `).run(id, JSON.stringify(messages), Date.now());
  }

  async applyGeneratedTitle(id: string, title: string): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE sessions SET title = ?
      WHERE id = ? AND title_edited = 0 AND message_count <= 1
    `).run(title, id);
    return result.changes > 0;
  }

  async dispose(): Promise<void> {
    for (const id of this.deltaBuffers.keys()) this.flushDeltas(id);
    this.db.close();
  }

  private flushDeltas(id: string): void {
    const timer = this.deltaTimers.get(id);
    if (timer) clearTimeout(timer);
    this.deltaTimers.delete(id);
    const text = this.deltaBuffers.get(id);
    if (!text) return;
    this.deltaBuffers.delete(id);
    this.insertRecord.run(id, Date.now(), "event", JSON.stringify({ type: "text-delta", text }));
  }

  private insertSession(meta: SessionMeta): void {
    this.db.prepare(`
      INSERT INTO sessions (
        id, title, title_edited, created_at, updated_at, workspace_root,
        provider_id, model_id, preset, message_count, parent_id, agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      meta.id,
      meta.title,
      meta.titleEdited ? 1 : 0,
      meta.createdAt,
      meta.updatedAt,
      meta.workspaceRoot,
      meta.model.providerID,
      meta.model.modelID,
      meta.preset,
      meta.messageCount,
      meta.parentID ?? null,
      meta.agent ?? null,
    );
  }

  private migrateLegacy(dir: string): void {
    const migrated = this.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(LEGACY_MIGRATION_KEY);
    if (migrated) return;
    const indexPath = join(dir, "index.json");
    let legacy: LegacyIndexFile = { sessions: [] };
    let canComplete = true;
    if (existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as LegacyIndexFile;
        if (!Array.isArray(parsed.sessions)) canComplete = false;
        else legacy = parsed;
      } catch (error) {
        canComplete = false;
        console.warn(
          "Legacy session index could not be imported; it will be retried:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    try {
      this.transaction(() => {
      const insertRecord = this.db.prepare(
        "INSERT INTO records (session_id, at, kind, payload_json) VALUES (?, ?, ?, ?)",
      );
      const insertHistory = this.db.prepare(
        "INSERT OR REPLACE INTO histories (session_id, messages_json, updated_at) VALUES (?, ?, ?)",
      );
      for (const value of legacy.sessions ?? []) {
        if (!validLegacySession(value)) {
          console.warn("Skipping malformed legacy session metadata");
          continue;
        }
        const model = typeof value.model === "string"
          ? { providerID: this.legacyProviderID, modelID: value.model }
          : value.model;
        const meta = { ...value, model } as SessionMeta;
        const exists = this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(meta.id);
        if (!exists) this.insertSession(meta);

        const eventsPath = join(dir, `${meta.id}.events.jsonl`);
        const recordsKey = `legacy_records:${meta.id}`;
        if (!this.migrationStepDone(recordsKey) && existsSync(eventsPath)) {
          let lines: string[] = [];
          let readable = false;
          try {
            lines = readFileSync(eventsPath, "utf8").split("\n");
            readable = true;
          } catch {
            throw new RetryLegacyMigrationError(`Legacy replay log is temporarily unreadable for ${meta.id}`);
          }
          if (readable) {
            for (const line of lines) {
              if (!line.trim()) continue;
              let record: SessionRecord;
              try {
                record = JSON.parse(line) as SessionRecord;
              } catch {
                // A torn final JSONL line is ignored, matching legacy replay.
                continue;
              }
              if (!validLegacyRecord(record)) continue;
              insertRecord.run(
                meta.id,
                record.at,
                record.kind,
                JSON.stringify(record.kind === "user" ? record.text : record.event),
              );
            }
            this.markMigrationStep(recordsKey);
          }
        } else if (!existsSync(eventsPath)) {
          this.markMigrationStep(recordsKey);
        }

        const historyPath = join(dir, `${meta.id}.history.json`);
        const historyKey = `legacy_history:${meta.id}`;
        if (!this.migrationStepDone(historyKey) && existsSync(historyPath)) {
          let messages: string | undefined;
          let readable = false;
          try {
            const raw = readFileSync(historyPath, "utf8");
            readable = true;
            if (validModelHistory(JSON.parse(raw))) messages = raw;
          } catch (error) {
            if (error instanceof Error && "code" in error) {
              throw new RetryLegacyMigrationError(`Legacy history is temporarily unreadable for ${meta.id}`);
            }
            console.warn(`Skipping malformed legacy history for ${meta.id}`);
          }
          if (messages) insertHistory.run(meta.id, messages, Date.now());
          if (readable) this.markMigrationStep(historyKey);
        } else if (!existsSync(historyPath)) {
          this.markMigrationStep(historyKey);
        }
      }
      if (canComplete) {
        this.db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)").run(LEGACY_MIGRATION_KEY, "done");
      }
      });
    } catch (error) {
      if (error instanceof RetryLegacyMigrationError) {
        console.warn(`${error.message}; import will be retried`);
        return;
      }
      throw error;
    }
  }

  private transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrationStepDone(key: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM app_meta WHERE key = ?").get(key));
  }

  private markMigrationStep(key: string): void {
    this.db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, 'done')").run(key);
  }
}

function validLegacySession(value: unknown): value is LegacySession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<LegacySession>;
  const modelValid = typeof session.model === "string" || Boolean(
    session.model && typeof session.model.providerID === "string" && typeof session.model.modelID === "string"
  );
  return typeof session.id === "string" && /^[A-Za-z0-9_-]+$/.test(session.id)
    && typeof session.title === "string"
    && Number.isFinite(session.createdAt)
    && Number.isFinite(session.updatedAt)
    && (session.workspaceRoot === null || typeof session.workspaceRoot === "string")
    && modelValid
    && typeof session.preset === "string" && ["full", "ask", "plan"].includes(session.preset)
    && Number.isFinite(session.messageCount);
}

function validLegacyRecord(record: SessionRecord): boolean {
  if (!record || !Number.isFinite(record.at)) return false;
  if (record.kind === "user") return typeof record.text === "string";
  return record.kind === "event" && validSessionEvent(record.event);
}

function validModelHistory(value: unknown): value is ModelMessage[] {
  return Array.isArray(value) && value.every((message) => {
    if (!message || typeof message !== "object") return false;
    const candidate = message as Record<string, unknown>;
    switch (candidate.role) {
      case "system":
        return typeof candidate.content === "string";
      case "user":
        return typeof candidate.content === "string"
          || validContentParts(candidate.content, new Set(["text", "image", "file"]));
      case "assistant":
        return typeof candidate.content === "string"
          || validContentParts(candidate.content, new Set([
            "text", "reasoning", "file", "reasoning-file", "tool-call", "tool-result",
            "tool-approval-request", "custom",
          ]));
      case "tool":
        return validContentParts(candidate.content, new Set(["tool-result", "tool-approval-response"]));
      default:
        return false;
    }
  });
}

function validContentParts(value: unknown, allowed: Set<string>): boolean {
  return Array.isArray(value) && value.every((part) => {
    if (!part || typeof part !== "object") return false;
    const candidate = part as Record<string, unknown>;
    if (typeof candidate.type !== "string" || !allowed.has(candidate.type)) return false;
    switch (candidate.type) {
      case "text":
      case "reasoning":
        return typeof candidate.text === "string";
      case "image":
        return Object.hasOwn(candidate, "image");
      case "file":
      case "reasoning-file":
        return typeof candidate.mediaType === "string" && Object.hasOwn(candidate, "data");
      case "tool-call":
        return typeof candidate.toolCallId === "string"
          && typeof candidate.toolName === "string"
          && Object.hasOwn(candidate, "input");
      case "tool-result":
        return typeof candidate.toolCallId === "string"
          && typeof candidate.toolName === "string"
          && (Object.hasOwn(candidate, "output") || Object.hasOwn(candidate, "result"));
      case "tool-approval-request":
        return typeof candidate.approvalId === "string" && typeof candidate.toolCallId === "string";
      case "tool-approval-response":
        return typeof candidate.approvalId === "string" && typeof candidate.approved === "boolean";
      case "custom":
        return typeof candidate.kind === "string";
      default:
        return false;
    }
  });
}

function validSessionEvent(value: unknown, depth = 0): value is SessionEvent {
  if (!value || typeof value !== "object" || depth > 10) return false;
  const event = value as Record<string, unknown>;
  const string = (key: string) => typeof event[key] === "string";
  switch (event.type) {
    case "session-start": return string("sessionId");
    case "title-change": return string("title");
    case "text-delta": return string("text");
    case "tool-call-start": return string("toolCallId") && string("toolName");
    case "tool-result": return string("toolCallId") && string("toolName") && typeof event.isError === "boolean";
    case "step-finish": return typeof event.stepNumber === "number";
    case "error": return string("message");
    case "mode-change": return event.mode === "build" || event.mode === "plan";
    case "effort-change": return event.effort === undefined || string("effort");
    case "reasoning-start": return string("id");
    case "reasoning-delta": return string("id") && string("text");
    case "reasoning-end": return string("id") && (event.durationMs === undefined || typeof event.durationMs === "number");
    case "permission-asked": return validRequest(event.request);
    case "permission-replied": return string("requestId") && ["once", "always", "reject"].includes(String(event.reply));
    case "question-asked": return validRequest(event.request);
    case "question-answered": return string("requestId") && Array.isArray(event.answers);
    case "question-rejected": return string("requestId");
    case "subagent-start": return string("toolCallId") && string("sessionId") && string("agent") && string("description");
    case "subagent-event": return string("toolCallId") && string("sessionId") && validSessionEvent(event.event, depth + 1);
    case "subagent-finish": return string("toolCallId") && string("sessionId") && string("result")
      && (event.isError === undefined || typeof event.isError === "boolean");
    case "finish": return string("reason") && (event.usage === undefined || Boolean(event.usage && typeof event.usage === "object"));
    default: return false;
  }
}

function validRequest(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  return typeof request.id === "string" && typeof request.sessionId === "string";
}

function sessionFromRow(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    title: row.title,
    titleEdited: Boolean(row.title_edited),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workspaceRoot: row.workspace_root,
    model: { providerID: row.provider_id, modelID: row.model_id },
    preset: row.preset,
    messageCount: row.message_count,
    parentID: row.parent_id,
    agent: row.agent ?? undefined,
  };
}
