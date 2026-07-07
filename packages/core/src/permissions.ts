import { randomUUID } from "node:crypto";
import type {
  ApprovalHandler,
  PermissionDecision,
  PermissionPolicy,
} from "@cozycode/protocol";
import { classifyCommand } from "./tools/shell-safety.ts";

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
 *
 * For `run_shell` with an `ask` policy, commands are classified:
 *   - `safe`        -> auto-allowed without prompting
 *   - `destructive` -> resolved via `shellDestructiveDecision` (default "ask")
 *   - `unknown`     -> always deferred to the frontend ("ask")
 *
 * Explicit `allow`/`deny` policy always wins over classification.
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

    // decision === "ask": classify shell commands for auto-handling.
    if (
      input.toolName === "run_shell" &&
      typeof input.args === "object" &&
      input.args !== null
    ) {
      const command = (input.args as { command?: string }).command ?? "";
      const classification = classifyCommand(command);

      if (classification === "safe") {
        return { allowed: true, decision: "allow" };
      }

      if (classification === "destructive") {
        const destructiveDecision =
          this.policy.shellDestructiveDecision ?? "ask";
        if (destructiveDecision === "deny") {
          return { allowed: false, decision: "deny" };
        }
        // Fall through to the approval handler (ask).
      }

      // classification === "unknown" — always ask. Fall through.
    }

    // Defer to the frontend.
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
