import { app } from "electron";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "@cozycode/core";
import type { SessionEvent } from "@cozycode/protocol";
import type {
  PermissionPreset,
  SessionMeta,
  SessionRecord,
} from "../shared/ipc.ts";

interface IndexFile {
  version: 1;
  sessions: SessionMeta[];
}

const MAX_TITLE = 60;

function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_TITLE) return clean || "New chat";
  return clean.slice(0, MAX_TITLE - 1).trimEnd() + "…";
}

/**
 * Owns the on-disk session archive under `userData/sessions/`:
 *   - index.json            — the SessionMeta list (atomic writes)
 *   - <id>.events.jsonl     — append-only replay log (user turns + events)
 *   - <id>.history.json     — ModelMessage[] snapshot for model-context resume
 *
 * The event log drives transcript replay in the renderer; the history snapshot
 * seeds a resumed core Session so the model keeps prior context. Consecutive
 * text-delta events are coalesced into a single record to keep logs small.
 */
export class SessionStore {
  private readonly dir = join(app.getPath("userData"), "sessions");
  private index: IndexFile | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();

  // Per-session append stream + a buffer that coalesces streaming text deltas.
  private readonly streams = new Map<string, WriteStream>();
  private readonly deltaBuffers = new Map<string, string>();

  private indexPath(): string {
    return join(this.dir, "index.json");
  }
  private eventsPath(id: string): string {
    return join(this.dir, `${id}.events.jsonl`);
  }
  private historyPath(id: string): string {
    return join(this.dir, `${id}.history.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async loadIndex(): Promise<IndexFile> {
    if (this.index) return this.index;
    try {
      const raw = await readFile(this.indexPath(), "utf8");
      const parsed = JSON.parse(raw) as IndexFile;
      this.index = parsed?.sessions ? parsed : { version: 1, sessions: [] };
    } catch {
      this.index = { version: 1, sessions: [] };
    }
    return this.index;
  }

  /** Serialize index writes and write atomically (tmp + rename). */
  private persistIndex(): Promise<void> {
    const write = this.writeQueue.then(async () => {
      await this.ensureDir();
      const tmp = `${this.indexPath()}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(this.index, null, 2), "utf8");
      await rename(tmp, this.indexPath());
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  async list(): Promise<SessionMeta[]> {
    const idx = await this.loadIndex();
    return [...idx.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<SessionMeta | undefined> {
    const idx = await this.loadIndex();
    return idx.sessions.find((s) => s.id === id);
  }

  async create(opts: {
    workspaceRoot: string | null;
    model: string;
    preset: PermissionPreset;
    now: number;
    title?: string;
  }): Promise<SessionMeta> {
    const idx = await this.loadIndex();
    const meta: SessionMeta = {
      id: randomUUID(),
      title: opts.title ?? "New chat",
      titleEdited: Boolean(opts.title),
      createdAt: opts.now,
      updatedAt: opts.now,
      workspaceRoot: opts.workspaceRoot,
      model: opts.model,
      preset: opts.preset,
      messageCount: 0,
    };
    idx.sessions.push(meta);
    await this.persistIndex();
    return meta;
  }

  async rename(id: string, title: string): Promise<void> {
    const idx = await this.loadIndex();
    const meta = idx.sessions.find((s) => s.id === id);
    if (!meta) return;
    meta.title = title;
    meta.titleEdited = true;
    await this.persistIndex();
  }

  /** Patch mutable metadata (model/preset/counts/updatedAt). */
  async touch(id: string, patch: Partial<SessionMeta>): Promise<void> {
    const idx = await this.loadIndex();
    const meta = idx.sessions.find((s) => s.id === id);
    if (!meta) return;
    Object.assign(meta, patch);
    await this.persistIndex();
  }

  async remove(id: string): Promise<void> {
    await this.closeStream(id);
    const idx = await this.loadIndex();
    idx.sessions = idx.sessions.filter((s) => s.id !== id);
    await this.persistIndex();
    await Promise.allSettled([
      rm(this.eventsPath(id), { force: true }),
      rm(this.historyPath(id), { force: true }),
    ]);
  }

  // --- replay log ---------------------------------------------------------

  private stream(id: string): WriteStream {
    let s = this.streams.get(id);
    if (!s) {
      s = createWriteStream(this.eventsPath(id), { flags: "a" });
      this.streams.set(id, s);
    }
    return s;
  }

  private writeLine(id: string, record: SessionRecord): void {
    this.stream(id).write(JSON.stringify(record) + "\n");
  }

  private flushDeltas(id: string): void {
    const buffered = this.deltaBuffers.get(id);
    if (buffered) {
      this.deltaBuffers.delete(id);
      this.writeLine(id, {
        at: Date.now(),
        kind: "event",
        event: { type: "text-delta", text: buffered },
      });
    }
  }

  /** Record a user turn (flushing any pending deltas first). */
  appendUser(id: string, text: string): void {
    this.flushDeltas(id);
    this.writeLine(id, { at: Date.now(), kind: "user", text });
  }

  /** Record a session event, coalescing consecutive text deltas. */
  appendEvent(id: string, event: SessionEvent): void {
    if (event.type === "text-delta") {
      this.deltaBuffers.set(id, (this.deltaBuffers.get(id) ?? "") + event.text);
      return;
    }
    this.flushDeltas(id);
    this.writeLine(id, { at: Date.now(), kind: "event", event });
  }

  private async closeStream(id: string): Promise<void> {
    this.flushDeltas(id);
    const s = this.streams.get(id);
    if (s) {
      this.streams.delete(id);
      await new Promise<void>((resolve) => s.end(resolve));
    }
  }

  /**
   * Read a session's transcript records for replay. If the log ended mid-turn
   * (last record isn't a finish/error), append a synthetic interrupted finish
   * so the renderer doesn't render a stuck "working…" / streaming cursor.
   */
  async readRecords(id: string): Promise<SessionRecord[]> {
    await this.closeStream(id);
    let raw: string;
    try {
      raw = await readFile(this.eventsPath(id), "utf8");
    } catch {
      return [];
    }
    const records: SessionRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as SessionRecord);
      } catch {
        // Skip a torn final line.
      }
    }
    const last = records[records.length - 1];
    const lastEvent = last?.kind === "event" ? last.event.type : undefined;
    if (records.length && lastEvent !== "finish" && lastEvent !== "error") {
      records.push({
        at: Date.now(),
        kind: "event",
        event: { type: "finish", reason: "interrupted" },
      });
    }
    return records;
  }

  // --- model-context history ----------------------------------------------

  async readHistory(id: string): Promise<ModelMessage[] | undefined> {
    try {
      const raw = await readFile(this.historyPath(id), "utf8");
      return JSON.parse(raw) as ModelMessage[];
    } catch {
      return undefined;
    }
  }

  writeHistory(id: string, messages: ModelMessage[]): Promise<void> {
    const write = this.writeQueue.then(async () => {
      await this.ensureDir();
      const tmp = `${this.historyPath(id)}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify(messages), "utf8");
      await rename(tmp, this.historyPath(id));
    });
    this.writeQueue = write.catch(() => {});
    return write;
  }

  /** Auto-title from the first user message if the user hasn't renamed it. */
  async maybeAutoTitle(id: string, firstMessage: string): Promise<boolean> {
    const idx = await this.loadIndex();
    const meta = idx.sessions.find((s) => s.id === id);
    if (!meta || meta.titleEdited || meta.messageCount > 0) return false;
    meta.title = deriveTitle(firstMessage);
    await this.persistIndex();
    return true;
  }

  /** Flush and close all open streams (call on window teardown). */
  async dispose(): Promise<void> {
    const ids = [...this.streams.keys()];
    await Promise.allSettled(ids.map((id) => this.closeStream(id)));
    await readdir(this.dir).catch(() => []); // no-op touch; keeps dir handle sane
  }
}
