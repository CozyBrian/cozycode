import { randomUUID } from "node:crypto";
import type {
  ApprovalHandler,
  PermissionDecision,
  PermissionPolicy,
} from "@cozycode/protocol";

export interface AuthorizeInput {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Short human-readable description of the pending action. */
  summary: string;
}

export interface AuthorizeResult {
  allowed: boolean;
  /** The policy decision before the approval round-trip resolved it. */
  decision: PermissionDecision;
}

/**
 * The safety boundary. Every tool call is routed through `authorize()` before
 * its real work runs:
 *   - `allow` -> proceeds silently
 *   - `deny`  -> blocked, the model gets a denial result
 *   - `ask`   -> the frontend's `ApprovalHandler` decides; "allow-session"
 *                remembers the grant for the rest of the session.
 */
export class PermissionGate {
  private readonly sessionGrants = new Set<string>();

  constructor(
    private readonly policy: PermissionPolicy,
    private readonly onApproval: ApprovalHandler,
  ) {}

  /** The effective decision for a tool, honoring session-wide grants. */
  resolve(toolName: string): PermissionDecision {
    if (this.sessionGrants.has(toolName)) return "allow";
    return this.policy.tools[toolName] ?? this.policy.defaultDecision;
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const decision = this.resolve(input.toolName);
    if (decision === "allow") return { allowed: true, decision };
    if (decision === "deny") return { allowed: false, decision };

    // decision === "ask": defer to the frontend.
    const outcome = await this.onApproval({
      requestId: randomUUID(),
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      summary: input.summary,
    });

    if (outcome === "allow-session") {
      this.sessionGrants.add(input.toolName);
      return { allowed: true, decision };
    }
    if (outcome === "allow-once") return { allowed: true, decision };
    return { allowed: false, decision };
  }
}
