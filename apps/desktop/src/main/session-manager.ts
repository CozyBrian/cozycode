import type { WebContents } from "electron";
import {
  createSession,
  DEFAULT_PERMISSION_POLICY,
  type Session,
} from "@cozycode/core";
import type {
  AgentMode,
  ApprovalOutcome,
  ApprovalRequest,
  SessionConfig,
} from "@cozycode/protocol";
import { IPC } from "../shared/ipc.ts";
import type { SettingsStore } from "./settings.ts";

/**
 * Owns the live agent session for a window. Bridges the core's async approval
 * handler to the renderer: when the gate asks, we push an `approval:request`
 * and park a promise until the renderer replies over `approval:respond`.
 */
export class SessionManager {
  private session: Session | null = null;
  private configKey = "";
  private currentMode: AgentMode = "build";
  private readonly pendingApprovals = new Map<string, (o: ApprovalOutcome) => void>();

  constructor(
    private readonly web: WebContents,
    private readonly settings: SettingsStore,
  ) {}

  private async buildConfig(): Promise<SessionConfig> {
    const s = await this.settings.getPublic();
    if (!s) throw new Error("No settings configured yet.");
    if (!s.baseURL || !s.model) throw new Error("Provider baseURL and model are required.");
    if (!s.workspaceRoot) throw new Error("A workspace folder is required.");
    return {
      provider: {
        name: s.providerName || "openai-compatible",
        baseURL: s.baseURL,
        apiKey: await this.settings.getApiKey(),
      },
      model: s.model,
      workspaceRoot: s.workspaceRoot,
      permissions: s.permissions ?? DEFAULT_PERMISSION_POLICY,
    };
  }

  /** (Re)build the session when settings change; otherwise reuse it. */
  private async ensureSession(): Promise<Session> {
    const config = await this.buildConfig();
    const key = JSON.stringify(config);
    if (this.session && key === this.configKey) return this.session;

    this.session?.close();
    this.configKey = key;
    // Carry the live mode across a settings-triggered rebuild so switching
    // providers/models mid-plan doesn't drop the user out of plan mode.
    if (this.currentMode !== "build") config.mode = this.currentMode;
    this.session = createSession(config, (req) => this.requestApproval(req));
    this.pump(this.session);
    return this.session;
  }

  /** Switch the agent mode (plan ↔ build) on the live session, if any. */
  setMode(mode: AgentMode): void {
    this.currentMode = mode;
    this.session?.setMode(mode);
  }

  /** The mode currently in effect (or the pending one if no session yet). */
  getMode(): AgentMode {
    return this.session?.mode ?? this.currentMode;
  }

  /** Forward session events to the renderer until the queue closes. */
  private async pump(session: Session): Promise<void> {
    for await (const event of session.events) {
      if (this.web.isDestroyed()) return;
      this.web.send(IPC.sessionEvent, event);
    }
  }

  private requestApproval(req: ApprovalRequest): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      this.pendingApprovals.set(req.requestId, resolve);
      if (!this.web.isDestroyed()) this.web.send(IPC.approvalRequest, req);
    });
  }

  resolveApproval(requestId: string, outcome: ApprovalOutcome): void {
    const resolve = this.pendingApprovals.get(requestId);
    if (resolve) {
      this.pendingApprovals.delete(requestId);
      resolve(outcome);
    }
  }

  async send(message: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const session = await this.ensureSession();
      await session.send(message);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  abort(): void {
    this.session?.abort();
  }

  /** Drop the current session so the next send starts a fresh conversation. */
  reset(): void {
    this.session?.close();
    this.session = null;
    this.configKey = "";
    // A fresh session resets to build mode.
    this.currentMode = "build";
    // Reject nothing — deny any dangling approvals so the old turn unblocks.
    for (const [id, resolve] of this.pendingApprovals) {
      resolve("deny");
      this.pendingApprovals.delete(id);
    }
  }

  dispose(): void {
    this.session?.close();
    this.session = null;
  }
}
