import type {
  PermissionRequest,
  QuestionRequest,
  SessionEvent,
  TokenUsage,
} from "@cozycode/protocol";
import type {
  SessionEventRecord,
  SessionMetadata,
  SessionReplaySnapshot,
  SessionRevertState,
  SessionTurnSummary,
} from "@cozycode/sessions";
import type { TuiSessionHostEvent, TuiSessionStatus } from "../runtime/session-host.ts";
import type { RenderItem, SubagentBlock, ToolStatus } from "../transcript.ts";

export interface TuiUsageTotal {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TuiSessionUsage {
  /** Usage from the latest completed top-level turn. */
  turn: TokenUsage | null;
  /** Top-level and nested subagent usage accumulated for the visible replay. */
  total: TuiUsageTotal;
}

export interface TuiSessionDraft {
  text: string;
  revision: number;
}

export interface TuiRollbackCursorSummary {
  revision: number;
  boundaryTurnID: string;
  boundaryOrdinal: number;
  boundarySeq: number;
  visibleTurnCount: number;
  originalTurnCount: number;
}

export type TuiUnreadState = "completion" | "error" | null;

export interface TuiSessionView {
  /** Monotonic local guard for asynchronous hydration and persistence work. */
  revision: number;
  /** True once an archive snapshot has supplied this view's replay baseline. */
  hydrated: boolean;
  stableItems: readonly RenderItem[];
  activeTurnItemsByID: Readonly<Record<string, readonly RenderItem[]>>;
  activeTurnOrder: readonly string[];
  status: TuiSessionStatus;
  statusUpdatedAt: number;
  usage: TuiSessionUsage;
  pendingPermissions: readonly PermissionRequest[];
  pendingQuestions: readonly QuestionRequest[];
  draft: TuiSessionDraft;
  rollbackCursor: TuiRollbackCursorSummary | null;
  unread: TuiUnreadState;
  /** The replay begins after older durable transcript records. */
  earlierEventsOmitted: boolean;
  /** The timeline contains only its most recent durable turn summaries. */
  earlierTurnsOmitted: boolean;
  lastEventSeq: number;
}

export interface TuiAppStoreState {
  revision: number;
  activeSessionID: string | null;
  metadataByID: Readonly<Record<string, SessionMetadata>>;
  viewsBySessionID: Readonly<Record<string, TuiSessionView>>;
}

export interface HydrateSessionOptions {
  /** Reject the snapshot if local work changed the view after this revision was captured. */
  expectedRevision?: number;
  status?: TuiSessionStatus;
  rollbackCursor?: SessionRevertState | TuiRollbackCursorSummary | null;
}

export interface ReplaceSessionOptions {
  status?: TuiSessionStatus;
  rollbackCursor?: SessionRevertState | TuiRollbackCursorSummary | null;
  activate?: boolean;
}

export interface DraftMutationResult {
  applied: boolean;
  draft: TuiSessionDraft;
}

export type TuiStoreListener = () => void;

const EMPTY_USAGE_TOTAL: TuiUsageTotal = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};
const EMPTY_RENDER_ITEMS: readonly RenderItem[] = [];

const renderItemsCache = new WeakMap<TuiSessionView, readonly RenderItem[]>();
const orderedSessionsCache = new WeakMap<TuiAppStoreState, readonly SessionMetadata[]>();

/** The active session projection. Suitable for a `useSyncExternalStore` selector. */
export function selectActiveView(state: TuiAppStoreState): TuiSessionView | undefined {
  return state.activeSessionID ? state.viewsBySessionID[state.activeSessionID] : undefined;
}

/** Archive-compatible ordering: most recently updated first, then stable ID order. */
export function selectOrderedSessions(state: TuiAppStoreState): readonly SessionMetadata[] {
  const cached = orderedSessionsCache.get(state);
  if (cached) return cached;
  const ordered = Object.values(state.metadataByID).sort((left, right) =>
    right.updatedAt - left.updatedAt || compareIDs(left.id, right.id)
  );
  orderedSessionsCache.set(state, ordered);
  return ordered;
}

export function selectAggregatePendingCount(state: TuiAppStoreState): number {
  let count = 0;
  for (const view of Object.values(state.viewsBySessionID)) {
    count += view.pendingPermissions.length + view.pendingQuestions.length;
  }
  return count;
}

/** Stable replay followed by optimistic/live turn buffers in acceptance order. */
export function selectRenderItems(
  state: TuiAppStoreState,
  sessionID: string | null = state.activeSessionID,
): readonly RenderItem[] {
  if (!sessionID) return EMPTY_RENDER_ITEMS;
  const view = state.viewsBySessionID[sessionID];
  if (!view) return EMPTY_RENDER_ITEMS;
  const cached = renderItemsCache.get(view);
  if (cached) return cached;
  if (view.activeTurnOrder.length === 0) {
    renderItemsCache.set(view, view.stableItems);
    return view.stableItems;
  }
  const items = [...view.stableItems];
  for (const turnID of view.activeTurnOrder) {
    items.push(...(view.activeTurnItemsByID[turnID] ?? []));
  }
  renderItemsCache.set(view, items);
  return items;
}

/**
 * React-free external application store. `subscribe` and `getSnapshot` can be
 * passed directly to `useSyncExternalStore`.
 */
export class TuiAppStore {
  private snapshot: TuiAppStoreState;
  private readonly listeners = new Set<TuiStoreListener>();

  constructor(metadata: readonly SessionMetadata[] = []) {
    const metadataByID: Record<string, SessionMetadata> = {};
    const viewsBySessionID: Record<string, TuiSessionView> = {};
    for (const item of metadata) {
      metadataByID[item.id] = item;
      viewsBySessionID[item.id] = emptyView();
    }
    this.snapshot = {
      revision: 0,
      activeSessionID: null,
      metadataByID,
      viewsBySessionID,
    };
  }

  readonly getSnapshot = (): TuiAppStoreState => this.snapshot;

  readonly getServerSnapshot = (): TuiAppStoreState => this.snapshot;

  readonly getState = (): TuiAppStoreState => this.snapshot;

  readonly subscribe = (listener: TuiStoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly upsertMetadata = (metadata: SessionMetadata): boolean => {
    const current = this.snapshot.metadataByID[metadata.id];
    if (current && metadata.updatedAt < current.updatedAt) return false;
    const view = this.snapshot.viewsBySessionID[metadata.id];
    this.publish({
      ...this.snapshot,
      metadataByID: { ...this.snapshot.metadataByID, [metadata.id]: metadata },
      viewsBySessionID: view
        ? this.snapshot.viewsBySessionID
        : { ...this.snapshot.viewsBySessionID, [metadata.id]: emptyView() },
    });
    return true;
  };

  readonly removeMetadata = (sessionID: string): boolean => {
    if (!this.snapshot.metadataByID[sessionID] && !this.snapshot.viewsBySessionID[sessionID]) {
      return false;
    }
    const metadataByID = { ...this.snapshot.metadataByID };
    const viewsBySessionID = { ...this.snapshot.viewsBySessionID };
    delete metadataByID[sessionID];
    delete viewsBySessionID[sessionID];
    this.publish({
      ...this.snapshot,
      activeSessionID: this.snapshot.activeSessionID === sessionID
        ? null
        : this.snapshot.activeSessionID,
      metadataByID,
      viewsBySessionID,
    });
    return true;
  };

  readonly removeSession = this.removeMetadata;

  readonly setActiveSession = (sessionID: string | null): void => {
    if (sessionID && !this.snapshot.viewsBySessionID[sessionID]) {
      const viewsBySessionID = {
        ...this.snapshot.viewsBySessionID,
        [sessionID]: emptyView(),
      };
      this.publish({
        ...this.snapshot,
        activeSessionID: sessionID,
        viewsBySessionID,
      });
      return;
    }
    const view = sessionID ? this.snapshot.viewsBySessionID[sessionID] : undefined;
    if (this.snapshot.activeSessionID === sessionID && (!view || view.unread === null)) return;
    this.publish({
      ...this.snapshot,
      activeSessionID: sessionID,
      viewsBySessionID: sessionID && view?.unread
        ? {
            ...this.snapshot.viewsBySessionID,
            [sessionID]: { ...view, revision: view.revision + 1, unread: null },
          }
        : this.snapshot.viewsBySessionID,
    });
  };

  readonly markRead = (sessionID: string): boolean => {
    const view = this.snapshot.viewsBySessionID[sessionID];
    if (!view || view.unread === null) return false;
    this.replaceView(sessionID, { ...view, revision: view.revision + 1, unread: null });
    return true;
  };

  /**
   * Merge an archive load without allowing a late snapshot to erase newer
   * durable events, optimistic work, status changes, or draft revisions.
   */
  readonly hydrate = (
    archived: SessionReplaySnapshot,
    options: HydrateSessionOptions = {},
  ): boolean => {
    const sessionID = archived.metadata.id;
    const current = this.snapshot.viewsBySessionID[sessionID];
    const hydrated = viewFromArchive(archived, options.status, options.rollbackCursor);
    const revisionChanged = options.expectedRevision !== undefined
      && current?.revision !== options.expectedRevision;
    const staleSequence = Boolean(current && hydrated.lastEventSeq < current.lastEventSeq);
    const sameSequenceAfterLocalWork = Boolean(
      current
      && hydrated.lastEventSeq === current.lastEventSeq
      && (current.hydrated || current.revision > 0),
    );

    const metadata = newerMetadata(this.snapshot.metadataByID[sessionID], archived.metadata);
    if (current && (revisionChanged || staleSequence || sameSequenceAfterLocalWork)) {
      const merged = mergeSnapshotOnlyFields(current, hydrated, options.rollbackCursor);
      if (merged === current && metadata === this.snapshot.metadataByID[sessionID]) return false;
      this.publish({
        ...this.snapshot,
        metadataByID: { ...this.snapshot.metadataByID, [sessionID]: metadata },
        viewsBySessionID: merged === current
          ? this.snapshot.viewsBySessionID
          : { ...this.snapshot.viewsBySessionID, [sessionID]: merged },
      });
      return false;
    }

    const next = current
      ? {
          ...hydrated,
          revision: current.revision + 1,
          draft: newerDraft(current.draft, hydrated.draft),
          rollbackCursor: options.rollbackCursor === undefined
            ? current.rollbackCursor
            : hydrated.rollbackCursor,
          unread: this.snapshot.activeSessionID === sessionID ? null : current.unread,
        }
      : hydrated;
    this.publish({
      ...this.snapshot,
      metadataByID: { ...this.snapshot.metadataByID, [sessionID]: metadata },
      viewsBySessionID: { ...this.snapshot.viewsBySessionID, [sessionID]: next },
    });
    return true;
  };

  /** Force an authoritative visible replay replacement after undo, redo, or fork. */
  readonly replaceSession = (
    archived: SessionReplaySnapshot,
    options: ReplaceSessionOptions = {},
  ): void => {
    const sessionID = archived.metadata.id;
    const current = this.snapshot.viewsBySessionID[sessionID];
    const view = viewFromArchive(archived, options.status, options.rollbackCursor);
    const activate = options.activate ?? false;
    this.publish({
      ...this.snapshot,
      activeSessionID: activate ? sessionID : this.snapshot.activeSessionID,
      metadataByID: { ...this.snapshot.metadataByID, [sessionID]: archived.metadata },
      viewsBySessionID: {
        ...this.snapshot.viewsBySessionID,
        [sessionID]: {
          ...view,
          revision: (current?.revision ?? -1) + 1,
          draft: current ? newerDraft(current.draft, view.draft) : view.draft,
          unread: activate || this.snapshot.activeSessionID === sessionID ? null : view.unread,
        },
      },
    });
  };

  readonly beginOptimisticTurn = (
    sessionID: string,
    turnID: string,
    prompt: string,
  ): boolean => {
    const view = this.snapshot.viewsBySessionID[sessionID] ?? emptyView();
    if (view.activeTurnItemsByID[turnID]) return false;
    const activeTurnItemsByID = {
      ...view.activeTurnItemsByID,
      [turnID]: [userRenderItem(sessionID, turnID, prompt)],
    };
    this.replaceView(sessionID, {
      ...view,
      revision: view.revision + 1,
      activeTurnItemsByID,
      activeTurnOrder: [...view.activeTurnOrder, turnID],
      status: "queued",
      usage: { ...view.usage, turn: null },
      pendingPermissions: [],
      pendingQuestions: [],
      unread: this.snapshot.activeSessionID === sessionID ? null : view.unread,
    });
    return true;
  };

  readonly applyHostEvent = (addressed: TuiSessionHostEvent): boolean => {
    if (addressed.type === "session-event") return this.applySessionEvent(addressed);
    return this.applyStatusEvent(addressed);
  };

  readonly applyEvent = this.applyHostEvent;

  readonly updateDraft = (
    sessionID: string,
    text: string,
    expectedRevision?: number,
  ): DraftMutationResult => {
    const view = this.snapshot.viewsBySessionID[sessionID] ?? emptyView();
    if (expectedRevision !== undefined && view.draft.revision !== expectedRevision) {
      return { applied: false, draft: view.draft };
    }
    const draft = { text, revision: view.draft.revision + 1 };
    this.replaceView(sessionID, { ...view, revision: view.revision + 1, draft });
    return { applied: true, draft };
  };

  readonly clearDraft = (
    sessionID: string,
    expectedRevision?: number,
  ): DraftMutationResult => this.updateDraft(sessionID, "", expectedRevision);

  readonly setRollbackCursor = (
    sessionID: string,
    cursor: SessionRevertState | TuiRollbackCursorSummary | null,
  ): boolean => {
    const view = this.snapshot.viewsBySessionID[sessionID];
    if (!view) return false;
    const rollbackCursor = summarizeRollback(cursor);
    if (
      view.rollbackCursor
      && rollbackCursor
      && rollbackCursor.revision < view.rollbackCursor.revision
    ) {
      return false;
    }
    this.replaceView(sessionID, {
      ...view,
      revision: view.revision + 1,
      rollbackCursor,
    });
    return true;
  };

  private applySessionEvent(
    addressed: Extract<TuiSessionHostEvent, { type: "session-event" }>,
  ): boolean {
    if (addressed.record.sessionID !== addressed.sessionID) return false;
    if (
      addressed.turnID !== undefined
      && addressed.record.turnID !== undefined
      && addressed.turnID !== addressed.record.turnID
    ) {
      return false;
    }
    const sessionID = addressed.sessionID;
    const turnID = addressed.turnID ?? addressed.record.turnID;
    const view = this.snapshot.viewsBySessionID[sessionID] ?? emptyView();
    if (addressed.record.seq <= view.lastEventSeq) return false;

    let stableItems = view.stableItems;
    let activeTurnItemsByID = { ...view.activeTurnItemsByID };
    let activeTurnOrder = view.activeTurnOrder;
    let pendingPermissions = view.pendingPermissions;
    let pendingQuestions = view.pendingQuestions;
    let usage = view.usage;
    let status = view.status;
    let unread = view.unread;
    const event = addressed.event;
    const identity = eventIdentity(sessionID, turnID, `event:${addressed.record.seq}`);

    ({ pendingPermissions, pendingQuestions } = reducePending(
      pendingPermissions,
      pendingQuestions,
      event,
    ));
    usage = reduceUsage(usage, event);

    if (isTerminalEvent(event)) {
      if (turnID) {
        const buffer = activeTurnItemsByID[turnID] ?? [];
        const finalized = foldStoreEvent(buffer, event, identity);
        if (finalized.length) stableItems = [...stableItems, ...finalized];
        delete activeTurnItemsByID[turnID];
        activeTurnOrder = activeTurnOrder.filter((id) => id !== turnID);
      }
      pendingPermissions = [];
      pendingQuestions = [];
      status = event.type === "error" ? "error" : "idle";
      if (this.snapshot.activeSessionID !== sessionID) {
        if (event.type === "error") unread = "error";
        else if (event.reason !== "abort") unread = "completion";
      }
    } else if (turnID) {
      const hadBuffer = Boolean(activeTurnItemsByID[turnID]);
      activeTurnItemsByID[turnID] = foldStoreEvent(
        activeTurnItemsByID[turnID] ?? [],
        event,
        identity,
      );
      if (!hadBuffer) activeTurnOrder = [...activeTurnOrder, turnID];
    } else {
      stableItems = foldStoreEvent(stableItems, event, identity);
    }

    const nextView: TuiSessionView = {
      ...view,
      revision: view.revision + 1,
      stableItems,
      activeTurnItemsByID,
      activeTurnOrder,
      status,
      usage,
      pendingPermissions,
      pendingQuestions,
      unread,
      lastEventSeq: addressed.record.seq,
    };
    const metadata = metadataFromEvent(
      this.snapshot.metadataByID[sessionID],
      event,
      addressed.record.at,
    );
    this.publish({
      ...this.snapshot,
      metadataByID: metadata
        ? { ...this.snapshot.metadataByID, [sessionID]: metadata }
        : this.snapshot.metadataByID,
      viewsBySessionID: { ...this.snapshot.viewsBySessionID, [sessionID]: nextView },
    });
    return true;
  }

  private applyStatusEvent(
    addressed: Extract<TuiSessionHostEvent, { type: "status" }>,
  ): boolean {
    const sessionID = addressed.sessionID;
    const view = this.snapshot.viewsBySessionID[sessionID] ?? emptyView();
    if (addressed.at < view.statusUpdatedAt) return false;
    let stableItems = view.stableItems;
    let activeTurnItemsByID = { ...view.activeTurnItemsByID };
    let activeTurnOrder = view.activeTurnOrder;
    let pendingPermissions = view.pendingPermissions;
    let pendingQuestions = view.pendingQuestions;
    let unread = view.unread;

    if (addressed.status === "error" && addressed.turnID && activeTurnItemsByID[addressed.turnID]) {
      const buffer = activeTurnItemsByID[addressed.turnID];
      if (!buffer) return false;
      const error: SessionEvent = {
        type: "error",
        message: addressed.error ?? "The turn failed.",
      };
      const finalized = foldStoreEvent(
        buffer,
        error,
        eventIdentity(sessionID, addressed.turnID, `status:${addressed.at}`),
      );
      stableItems = [...stableItems, ...finalized];
      delete activeTurnItemsByID[addressed.turnID];
      activeTurnOrder = activeTurnOrder.filter((id) => id !== addressed.turnID);
      pendingPermissions = [];
      pendingQuestions = [];
      if (this.snapshot.activeSessionID !== sessionID) unread = "error";
    }

    this.replaceView(sessionID, {
      ...view,
      revision: view.revision + 1,
      stableItems,
      activeTurnItemsByID,
      activeTurnOrder,
      status: addressed.status,
      statusUpdatedAt: addressed.at,
      pendingPermissions,
      pendingQuestions,
      unread,
    });
    return true;
  }

  private replaceView(sessionID: string, view: TuiSessionView): void {
    this.publish({
      ...this.snapshot,
      viewsBySessionID: { ...this.snapshot.viewsBySessionID, [sessionID]: view },
    });
  }

  private publish(next: TuiAppStoreState): void {
    this.snapshot = { ...next, revision: this.snapshot.revision + 1 };
    for (const listener of [...this.listeners]) listener();
  }
}

export function createTuiAppStore(metadata: readonly SessionMetadata[] = []): TuiAppStore {
  return new TuiAppStore(metadata);
}

export const createTuiStore = createTuiAppStore;

function emptyView(): TuiSessionView {
  return {
    revision: 0,
    hydrated: false,
    stableItems: [],
    activeTurnItemsByID: {},
    activeTurnOrder: [],
    status: "idle",
    statusUpdatedAt: 0,
    usage: { turn: null, total: { ...EMPTY_USAGE_TOTAL } },
    pendingPermissions: [],
    pendingQuestions: [],
    draft: { text: "", revision: 0 },
    rollbackCursor: null,
    unread: null,
    earlierEventsOmitted: false,
    earlierTurnsOmitted: false,
    lastEventSeq: 0,
  };
}

function viewFromArchive(
  archived: SessionReplaySnapshot,
  requestedStatus?: TuiSessionStatus,
  rollback?: SessionRevertState | TuiRollbackCursorSummary | null,
): TuiSessionView {
  const sessionID = archived.metadata.id;
  const turns = archived.turns
    .filter((turn) => turn.sessionID === sessionID)
    .sort((left, right) => left.boundarySeq - right.boundarySeq || left.ordinal - right.ordinal);
  const events = archived.events
    .filter((record) => record.sessionID === sessionID)
    .sort((left, right) => left.seq - right.seq);
  const turnByID = new Map(turns.map((turn) => [turn.id, turn]));
  const replayTurns = "window" in archived && archived.window.eventsOmitted
    ? turnsForRecentEvents(turns, events)
    : turns;
  const actions: ReplayAction[] = [
    ...replayTurns.map((turn): ReplayAction => ({ kind: "turn", seq: turn.boundarySeq, turn })),
    ...events.map((record): ReplayAction => ({ kind: "event", seq: record.seq, record })),
  ].sort((left, right) =>
    left.seq - right.seq
    || (left.kind === right.kind ? replayTieBreak(left, right) : left.kind === "turn" ? -1 : 1)
  );

  let stableItems: readonly RenderItem[] = [];
  const buffers: Record<string, readonly RenderItem[]> = {};
  const bufferOrder: string[] = [];
  let pendingPermissions: readonly PermissionRequest[] = [];
  let pendingQuestions: readonly QuestionRequest[] = [];
  let usage: TuiSessionUsage = { turn: null, total: { ...EMPTY_USAGE_TOTAL } };

  const flushSettledBuffers = (beforeOrdinal: number): void => {
    for (const turnID of [...bufferOrder]) {
      const turn = turnByID.get(turnID);
      if (!turn || turn.status === "running" || turn.ordinal >= beforeOrdinal) continue;
      stableItems = [...stableItems, ...finalizeItems(buffers[turnID] ?? [], incompleteResult(turn))];
      delete buffers[turnID];
      bufferOrder.splice(bufferOrder.indexOf(turnID), 1);
    }
  };

  for (const action of actions) {
    if (action.kind === "turn") {
      flushSettledBuffers(action.turn.ordinal);
      buffers[action.turn.id] = [userRenderItem(sessionID, action.turn.id, action.turn.prompt)];
      if (!bufferOrder.includes(action.turn.id)) bufferOrder.push(action.turn.id);
      continue;
    }

    const { record } = action;
    ({ pendingPermissions, pendingQuestions } = reducePending(
      pendingPermissions,
      pendingQuestions,
      record.event,
    ));
    usage = reduceUsage(usage, record.event);
    if (isTerminalEvent(record.event)) {
      pendingPermissions = [];
      pendingQuestions = [];
    }

    if (record.turnID) {
      if (!buffers[record.turnID]) {
        buffers[record.turnID] = [];
        bufferOrder.push(record.turnID);
      }
      const buffer = buffers[record.turnID];
      if (!buffer) continue;
      buffers[record.turnID] = foldStoreEvent(
        buffer,
        record.event,
        eventIdentity(sessionID, record.turnID, `event:${record.seq}`),
      );
      if (isTerminalEvent(record.event)) {
        stableItems = [...stableItems, ...(buffers[record.turnID] ?? [])];
        delete buffers[record.turnID];
        bufferOrder.splice(bufferOrder.indexOf(record.turnID), 1);
      }
    } else if (!isTerminalEvent(record.event)) {
      stableItems = foldStoreEvent(
        stableItems,
        record.event,
        eventIdentity(sessionID, undefined, `event:${record.seq}`),
      );
    }
  }

  const activeTurnItemsByID: Record<string, readonly RenderItem[]> = {};
  const activeTurnOrder: string[] = [];
  for (const turnID of bufferOrder) {
    const turn = turnByID.get(turnID);
    const items = buffers[turnID] ?? [];
    if (turn?.status === "running") {
      activeTurnItemsByID[turnID] = items;
      activeTurnOrder.push(turnID);
    } else {
      stableItems = [...stableItems, ...finalizeItems(items, incompleteResult(turn))];
    }
  }

  const latestTurn = turns.at(-1);
  const inferredStatus: TuiSessionStatus = latestTurn?.status === "running"
    ? pendingPermissions.length || pendingQuestions.length ? "waiting" : "running"
    : latestTurn?.status === "failed" || latestTurn?.status === "interrupted"
      ? "error"
      : "idle";
  return {
    revision: 0,
    hydrated: true,
    stableItems,
    activeTurnItemsByID,
    activeTurnOrder,
    status: requestedStatus ?? inferredStatus,
    statusUpdatedAt: 0,
    usage,
    pendingPermissions,
    pendingQuestions,
    draft: archived.draft?.sessionID === sessionID
      ? { text: archived.draft.text, revision: archived.draft.revision }
      : { text: "", revision: 0 },
    rollbackCursor: summarizeRollback(rollback),
    unread: null,
    earlierEventsOmitted: "window" in archived && archived.window.eventsOmitted,
    earlierTurnsOmitted: "window" in archived && archived.window.turnsOmitted,
    lastEventSeq: events.at(-1)?.seq ?? ("window" in archived ? archived.window.lastEventSeq ?? 0 : 0),
  };
}

type ReplayAction =
  | { kind: "turn"; seq: number; turn: SessionTurnSummary }
  | { kind: "event"; seq: number; record: SessionEventRecord };

function replayTieBreak(left: ReplayAction, right: ReplayAction): number {
  if (left.kind === "turn" && right.kind === "turn") return left.turn.ordinal - right.turn.ordinal;
  if (left.kind === "event" && right.kind === "event") return left.record.seq - right.record.seq;
  return 0;
}

function turnsForRecentEvents(
  turns: SessionTurnSummary[],
  events: SessionEventRecord[],
): SessionTurnSummary[] {
  const eventTurnIDs = new Set(events.flatMap((record) => record.turnID ? [record.turnID] : []));
  const firstLoadedOrdinal = turns.find((turn) => eventTurnIDs.has(turn.id))?.ordinal;
  if (firstLoadedOrdinal === undefined) return turns.filter((turn) => turn.status === "running");
  return turns.filter((turn) => turn.ordinal >= firstLoadedOrdinal);
}

function mergeSnapshotOnlyFields(
  current: TuiSessionView,
  hydrated: TuiSessionView,
  rollback: HydrateSessionOptions["rollbackCursor"],
): TuiSessionView {
  const draft = newerDraft(current.draft, hydrated.draft);
  const rollbackCursor = rollback === undefined
    ? current.rollbackCursor
    : newerRollback(current.rollbackCursor, hydrated.rollbackCursor);
  if (draft === current.draft && rollbackCursor === current.rollbackCursor) return current;
  return {
    ...current,
    revision: current.revision + 1,
    draft,
    rollbackCursor,
  };
}

function newerDraft(current: TuiSessionDraft, incoming: TuiSessionDraft): TuiSessionDraft {
  return incoming.revision > current.revision ? incoming : current;
}

function newerRollback(
  current: TuiRollbackCursorSummary | null,
  incoming: TuiRollbackCursorSummary | null,
): TuiRollbackCursorSummary | null {
  if (!incoming) return current;
  if (!current || incoming.revision >= current.revision) return incoming;
  return current;
}

function summarizeRollback(
  cursor: SessionRevertState | TuiRollbackCursorSummary | null | undefined,
): TuiRollbackCursorSummary | null {
  if (!cursor) return null;
  return {
    revision: cursor.revision,
    boundaryTurnID: cursor.boundaryTurnID,
    boundaryOrdinal: cursor.boundaryOrdinal,
    boundarySeq: cursor.boundarySeq,
    visibleTurnCount: cursor.visibleTurnCount,
    originalTurnCount: cursor.originalTurnCount,
  };
}

function newerMetadata(
  current: SessionMetadata | undefined,
  incoming: SessionMetadata,
): SessionMetadata {
  return !current || incoming.updatedAt >= current.updatedAt ? incoming : current;
}

function metadataFromEvent(
  metadata: SessionMetadata | undefined,
  event: SessionEvent,
  at: number,
): SessionMetadata | undefined {
  if (!metadata) return undefined;
  const updatedAt = Math.max(metadata.updatedAt, at);
  if (event.type === "title-change") return { ...metadata, title: event.title, updatedAt };
  if (event.type === "mode-change") return { ...metadata, mode: event.mode, updatedAt };
  if (event.type === "effort-change") return { ...metadata, effort: event.effort, updatedAt };
  return updatedAt === metadata.updatedAt ? metadata : { ...metadata, updatedAt };
}

function reducePending(
  permissions: readonly PermissionRequest[],
  questions: readonly QuestionRequest[],
  event: SessionEvent,
): {
  pendingPermissions: readonly PermissionRequest[];
  pendingQuestions: readonly QuestionRequest[];
} {
  let pendingPermissions = permissions;
  let pendingQuestions = questions;
  if (event.type === "permission-asked") {
    if (!permissions.some((request) => request.id === event.request.id)) {
      pendingPermissions = [...permissions, event.request];
    }
  } else if (event.type === "permission-replied") {
    pendingPermissions = permissions.filter((request) => request.id !== event.requestId);
  } else if (event.type === "question-asked") {
    if (!questions.some((request) => request.id === event.request.id)) {
      pendingQuestions = [...questions, event.request];
    }
  } else if (event.type === "question-answered" || event.type === "question-rejected") {
    pendingQuestions = questions.filter((request) => request.id !== event.requestId);
  }
  return { pendingPermissions, pendingQuestions };
}

function reduceUsage(usage: TuiSessionUsage, event: SessionEvent): TuiSessionUsage {
  if (event.type === "finish") {
    return {
      turn: event.usage ?? usage.turn,
      total: addUsage(usage.total, event.usage),
    };
  }
  if (event.type === "subagent-event") {
    return {
      ...usage,
      total: addNestedUsage(usage.total, event.event),
    };
  }
  return usage;
}

function addNestedUsage(total: TuiUsageTotal, event: SessionEvent): TuiUsageTotal {
  if (event.type === "finish") return addUsage(total, event.usage);
  if (event.type === "subagent-event") return addNestedUsage(total, event.event);
  return total;
}

function addUsage(total: TuiUsageTotal, usage?: TokenUsage): TuiUsageTotal {
  if (!usage) return total;
  return {
    inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
    totalTokens: total.totalTokens + (usage.totalTokens ?? 0),
  };
}

function isTerminalEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "finish" | "error" }> {
  return event.type === "finish" || event.type === "error";
}

function incompleteResult(turn: SessionTurnSummary | undefined): string {
  return turn?.status === "aborted" ? "Stopped." : "Did not complete.";
}

interface ItemIdentity {
  sessionID: string;
  turnID?: string;
  source: string;
  path: string;
}

function eventIdentity(sessionID: string, turnID: string | undefined, source: string): ItemIdentity {
  return { sessionID, turnID, source, path: "" };
}

function nestedIdentity(identity: ItemIdentity, toolCallID: string, sessionID: string): ItemIdentity {
  return {
    ...identity,
    path: `${identity.path}/subagent:${encodeID(toolCallID)}:${encodeID(sessionID)}`,
  };
}

function itemID(identity: ItemIdentity, kind: string, detail?: string): string {
  const turn = identity.turnID ? `turn:${encodeID(identity.turnID)}` : "turn:unowned";
  return `session:${encodeID(identity.sessionID)}/${turn}/${identity.source}${identity.path}/${kind}${
    detail ? `:${encodeID(detail)}` : ""
  }`;
}

function userRenderItem(sessionID: string, turnID: string, text: string): RenderItem {
  return {
    id: `session:${encodeID(sessionID)}/turn:${encodeID(turnID)}/user`,
    kind: "user",
    text,
  };
}

/** Store-local adaptation of transcript folding with deterministic identities. */
function foldStoreEvent(
  current: readonly RenderItem[],
  event: SessionEvent,
  identity: ItemIdentity,
): readonly RenderItem[] {
  const items = current as readonly RenderItem[];
  switch (event.type) {
    case "text-delta": {
      const last = items.at(-1);
      if (last?.kind === "assistant" && last.streaming) {
        return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
      }
      return [
        ...items,
        { id: itemID(identity, "assistant"), kind: "assistant", text: event.text, streaming: true },
      ];
    }
    case "reasoning-start":
      return [
        ...items,
        {
          id: itemID(identity, "reasoning", event.id),
          kind: "reasoning",
          reasoningId: event.id,
          text: "",
          streaming: true,
        },
      ];
    case "reasoning-delta": {
      const index = lastReasoningIndex(items, event.id);
      if (index < 0) {
        return [
          ...items,
          {
            id: itemID(identity, "reasoning", event.id),
            kind: "reasoning",
            reasoningId: event.id,
            text: event.text,
            streaming: true,
          },
        ];
      }
      const reasoning = items[index] as Extract<RenderItem, { kind: "reasoning" }>;
      return replaceAt(items, index, { ...reasoning, text: reasoning.text + event.text });
    }
    case "reasoning-end": {
      const index = lastReasoningIndex(items, event.id);
      if (index < 0) return items;
      const reasoning = items[index] as Extract<RenderItem, { kind: "reasoning" }>;
      return replaceAt(items, index, {
        ...reasoning,
        streaming: false,
        durationMs: event.durationMs,
      });
    }
    case "tool-call-start":
      return [
        ...items,
        {
          id: itemID(identity, "tool", event.toolCallId),
          kind: "tool",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          status: "running",
        },
      ];
    case "tool-result":
      return items.map((item) =>
        item.kind === "tool" && item.toolCallId === event.toolCallId
          ? {
              ...item,
              status: toolStatus(event.isError, event.result),
              result: event.result,
              metadata: event.metadata,
            }
          : item
      );
    case "subagent-start":
      return items.map((item) =>
        item.kind === "tool" && item.toolCallId === event.toolCallId
          ? {
              ...item,
              subagent: {
                sessionId: event.sessionId,
                agent: event.agent,
                description: event.description,
                items: [],
                status: "running",
              },
            }
          : item
      );
    case "subagent-event":
      return items.map((item) =>
        item.kind === "tool" && item.toolCallId === event.toolCallId && item.subagent
          ? {
              ...item,
              subagent: {
                ...item.subagent,
                items: foldStoreEvent(
                  item.subagent.items,
                  event.event,
                  nestedIdentity(identity, event.toolCallId, event.sessionId),
                ) as RenderItem[],
              },
            }
          : item
      );
    case "subagent-finish":
      return items.map((item) =>
        item.kind === "tool" && item.toolCallId === event.toolCallId && item.subagent
          ? {
              ...item,
              subagent: {
                ...item.subagent,
                status: event.isError ? "error" : "done",
                result: event.result,
                items: finalizeItems(item.subagent.items) as RenderItem[],
              },
            }
          : item
      );
    case "error":
      return [
        ...finalizeItems(items),
        { id: itemID(identity, "error"), kind: "error", text: event.message },
      ];
    case "finish":
      return finalizeItems(items, event.reason === "abort" ? "Stopped." : "Did not complete.");
    default:
      return items;
  }
}

function finalizeItems(
  items: readonly RenderItem[],
  incompleteToolResult = "Did not complete.",
): readonly RenderItem[] {
  return items.map((item): RenderItem => {
    if (item.kind === "assistant" || item.kind === "reasoning") {
      return item.streaming ? { ...item, streaming: false } : item;
    }
    if (item.kind !== "tool") return item;
    const subagent: SubagentBlock | undefined = item.subagent?.status === "running"
      ? {
          ...item.subagent,
          status: "error",
          items: finalizeItems(item.subagent.items, incompleteToolResult) as RenderItem[],
        }
      : item.subagent;
    if (item.status === "running") {
      return { ...item, status: "error", result: incompleteToolResult, subagent };
    }
    return subagent === item.subagent ? item : { ...item, subagent };
  });
}

function lastReasoningIndex(items: readonly RenderItem[], reasoningID: string): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "reasoning" && item.reasoningId === reasoningID && item.streaming) {
      return index;
    }
  }
  return -1;
}

function replaceAt(
  items: readonly RenderItem[],
  index: number,
  item: RenderItem,
): readonly RenderItem[] {
  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

function toolStatus(isError: boolean, result: unknown): ToolStatus {
  if (isError) return "error";
  if (result && typeof result === "object" && (result as { denied?: boolean }).denied) {
    return "denied";
  }
  return "done";
}

function encodeID(value: string): string {
  return encodeURIComponent(value);
}

function compareIDs(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
