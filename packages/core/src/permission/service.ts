import type {
  PermissionReply,
  PermissionRequest,
  PermissionRule,
  Ruleset,
  SessionEvent,
} from "@cozycode/protocol";
import { wildcardMatch } from "./wildcard.ts";

/** The user rejected the tool call outright. */
export class PermissionRejectedError extends Error {
  constructor() {
    super("The user rejected permission to use this specific tool call.");
    this.name = "PermissionRejectedError";
  }
}

/** The user rejected the tool call and supplied corrective feedback for the model. */
export class PermissionCorrectedError extends Error {
  constructor(readonly feedback: string) {
    super(
      `The user rejected permission to use this specific tool call with the following feedback: ${feedback}`,
    );
    this.name = "PermissionCorrectedError";
  }
}

/** A configured `deny` rule blocked the tool call before it could be asked. */
export class PermissionDeniedError extends Error {
  constructor(readonly ruleset: Ruleset) {
    super(
      `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(ruleset)}`,
    );
    this.name = "PermissionDeniedError";
  }
}

/**
 * Evaluate a (permission, pattern) pair against one or more rulesets. Rules are
 * flattened and the LAST matching rule wins (later rules override earlier ones).
 * With no match, the pair defaults to `ask`.
 */
export function evaluateRule(
  permission: string,
  pattern: string,
  ...rulesets: Ruleset[]
): PermissionRule {
  return (
    rulesets
      .flat()
      .findLast(
        (rule) =>
          wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern),
      ) ?? { action: "ask", permission, pattern: "*" }
  );
}

export interface AskInput {
  permission: string;
  patterns: string[];
  always: string[];
  metadata: Record<string, unknown>;
  tool?: { callId: string; toolName: string };
}

interface PendingEntry {
  info: PermissionRequest;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * The permission boundary for one session (ported from opencode's V1 model).
 *
 * `ask()` evaluates a tool call's patterns against the ruleset plus runtime
 * "always" grants; it returns silently when everything is allowed, throws a
 * `PermissionDeniedError` when a `deny` rule matches, and otherwise parks a
 * pending request (emitting `permission-asked`) until a frontend replies.
 *
 * `reply()` resolves a pending request. `once`/`always` allow it (with `always`
 * also granting the request's `always` patterns for the rest of the session and
 * auto-resolving any other pending request the new grants now cover). `reject`
 * fails it and cascade-rejects every other pending request.
 */
export class PermissionService {
  private readonly pending = new Map<string, PendingEntry>();
  /** In-memory session "always" grants. Never persisted; cleared on setRuleset. */
  private approved: PermissionRule[] = [];
  private counter = 0;

  constructor(
    private ruleset: Ruleset,
    private readonly sessionId: string,
    private readonly emit: (event: SessionEvent) => void,
  ) {}

  /** Replace the ruleset and clear runtime grants (a tightened ruleset takes effect at once). */
  setRuleset(ruleset: Ruleset): void {
    this.ruleset = ruleset;
    this.approved = [];
  }

  listPending(): PermissionRequest[] {
    return Array.from(this.pending.values(), (entry) => entry.info);
  }

  async ask(input: AskInput): Promise<void> {
    let needsAsk = false;
    for (const pattern of input.patterns) {
      const rule = evaluateRule(input.permission, pattern, this.ruleset, this.approved);
      if (rule.action === "deny") {
        throw new PermissionDeniedError(
          this.ruleset.filter((r) => wildcardMatch(input.permission, r.permission)),
        );
      }
      if (rule.action === "allow") continue;
      needsAsk = true;
    }
    if (!needsAsk) return;

    const id = `per_${++this.counter}`;
    const info: PermissionRequest = {
      id,
      sessionId: this.sessionId,
      permission: input.permission,
      patterns: input.patterns,
      metadata: input.metadata,
      always: input.always,
      tool: input.tool,
    };

    try {
      await new Promise<void>((resolve, reject) => {
        this.pending.set(id, { info, resolve, reject });
        this.emit({ type: "permission-asked", request: info });
      });
    } finally {
      this.pending.delete(id);
    }
  }

  reply(requestId: string, reply: PermissionReply, message?: string): void {
    const existing = this.pending.get(requestId);
    if (!existing) return; // unknown / already-resolved id → no-op

    this.pending.delete(requestId);
    this.emit({ type: "permission-replied", requestId, reply });

    if (reply === "reject") {
      existing.reject(
        message ? new PermissionCorrectedError(message) : new PermissionRejectedError(),
      );
      // Cascade: rejecting one call abandons the turn, so reject the siblings too.
      for (const [id, item] of this.pending) {
        this.pending.delete(id);
        this.emit({ type: "permission-replied", requestId: id, reply: "reject" });
        item.reject(new PermissionRejectedError());
      }
      return;
    }

    existing.resolve();
    if (reply === "once") return;

    // "always": grant the request's always-patterns for the rest of the session,
    // then auto-resolve any other pending request the new grants now fully cover.
    for (const pattern of existing.info.always) {
      this.approved.push({ permission: existing.info.permission, pattern, action: "allow" });
    }
    for (const [id, item] of this.pending) {
      const covered = item.info.patterns.every(
        (pattern) => evaluateRule(item.info.permission, pattern, this.approved).action === "allow",
      );
      if (!covered) continue;
      this.pending.delete(id);
      this.emit({ type: "permission-replied", requestId: id, reply: "always" });
      item.resolve();
    }
  }

  /** Reject every pending request. Called on session teardown/abort. */
  rejectAll(): void {
    for (const [id, item] of this.pending) {
      this.pending.delete(id);
      this.emit({ type: "permission-replied", requestId: id, reply: "reject" });
      item.reject(new PermissionRejectedError());
    }
  }
}
