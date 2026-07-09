import { randomUUID } from "node:crypto";
import { ToolLoopAgent, isStepCount, type LanguageModel, type ModelMessage } from "ai";
import type {
  AgentMode,
  ApprovalHandler,
  PermissionPolicy,
  SessionConfig,
  SessionEvent,
  TokenUsage,
} from "@cozycode/protocol";
import { createModel } from "./model.ts";
import { PermissionGate } from "./permissions.ts";
import { buildTools } from "./tools/index.ts";
import { AsyncEventQueue } from "./events.ts";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_SYSTEM_PROMPT,
  BUILD_SWITCH_REMINDER,
  PLAN_MODE_REMINDER,
} from "./config.ts";

export interface SessionOptions {
  /** Inject a pre-built language model, bypassing provider-config construction. */
  model?: LanguageModel;
  /** Stable session id (e.g. restored from disk); defaults to a fresh UUID. */
  id?: string;
  /** Seed the conversation history so context carries across a resume/rebuild. */
  initialHistory?: ModelMessage[];
}

/**
 * A conversation with the coding agent. Owns the message history, the model,
 * the permission gate, and the tool set. `events` is a long-lived stream a
 * frontend consumes for the whole session; each `send()` drives one agent turn
 * and emits into that stream.
 */
export class Session {
  readonly id: string;
  readonly events = new AsyncEventQueue<SessionEvent>();

  private readonly history: ModelMessage[] = [];
  private readonly gate: PermissionGate;
  private readonly tools: ReturnType<typeof buildTools>;
  private agent: ToolLoopAgent;
  private currentModel: string;
  private currentMode: AgentMode;
  private abortController: AbortController | null = null;
  private stepCounter = 0;
  private hadPlanTurn = false;
  private buildSwitchPending = false;
  // The model used to build the current agent, retained so a mode change can
  // rebuild with the same model rather than reconstructing the provider model.
  private activeModel: LanguageModel;

  constructor(
    private readonly config: SessionConfig,
    approvalHandler: ApprovalHandler,
    options: SessionOptions = {},
  ) {
    this.id = options.id ?? randomUUID();
    if (options.initialHistory?.length) this.history.push(...options.initialHistory);
    const initialMode = config.mode ?? "build";
    this.currentMode = initialMode;
    this.gate = new PermissionGate(config.permissions, approvalHandler, initialMode);
    this.tools = buildTools({
      ctx: { workspaceRoot: config.workspaceRoot },
      gate: this.gate,
      emit: (e) => this.events.push(e),
    });
    this.currentModel = config.model;
    // A pre-built model can be injected (tests, custom wrapping); otherwise we
    // build one from the provider config.
    this.activeModel = options.model ?? createModel(config.provider, config.model);
    this.agent = this.buildAgent(this.activeModel);
  }

  /** The model id currently in use. */
  get model(): string {
    return this.currentModel;
  }

  /** The agent mode currently in effect. */
  get mode(): AgentMode {
    return this.currentMode;
  }

  /**
   * A deep copy of the conversation history, suitable for persisting and later
   * seeding a new session via `SessionOptions.initialHistory`.
   */
  snapshotHistory(): ModelMessage[] {
    return structuredClone(this.history);
  }

  /** Replace the permission policy live (e.g. switching a permission preset). */
  setPermissions(policy: PermissionPolicy): void {
    this.gate.setPolicy(policy);
  }

  /**
   * Switch the model mid-session, rebuilding the agent while preserving the
   * message history so conversation context carries across the change.
   */
  setModel(model: string): void {
    if (model === this.currentModel) return;
    this.currentModel = model;
    this.activeModel = createModel(this.config.provider, model);
    this.agent = this.buildAgent(this.activeModel);
  }

  /**
   * Switch the agent mode mid-session. Emits a `mode-change` event so frontends
   * can render a transition marker. The base system prompt stays constant;
   * mode-specific reminders are injected into user messages in `send()`.
   */
  setMode(mode: AgentMode): void {
    if (mode === this.currentMode) return;
    if (this.currentMode === "plan" && mode === "build" && this.hadPlanTurn) {
      this.buildSwitchPending = true;
      this.hadPlanTurn = false;
    }
    this.currentMode = mode;
    this.gate.setMode(mode);
    this.events.push({ type: "mode-change", mode });
  }

  private buildAgent(model: LanguageModel): ToolLoopAgent {
    return new ToolLoopAgent({
      model,
      instructions: this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      tools: this.tools,
      stopWhen: isStepCount(this.config.maxSteps ?? DEFAULT_MAX_STEPS),
    });
  }

  /** Run one agent turn for the given user message. Resolves when the turn ends. */
  async send(userMessage: string): Promise<void> {
    const mode = this.currentMode;
    const parts: Array<{ type: "text"; text: string }> = [
      { type: "text", text: userMessage },
    ];
    if (mode === "plan") {
      parts.push({ type: "text", text: PLAN_MODE_REMINDER });
      this.hadPlanTurn = true;
    } else if (this.buildSwitchPending) {
      parts.push({ type: "text", text: BUILD_SWITCH_REMINDER });
      this.buildSwitchPending = false;
    }
    this.history.push({ role: "user", content: parts });
    this.abortController = new AbortController();
    this.events.push({ type: "session-start", sessionId: this.id });

    try {
      const result = await this.agent.stream({
        messages: this.history,
        abortSignal: this.abortController.signal,
      });

      for await (const part of result.fullStream) {
        this.mapPart(part);
      }

      // Persist the model's generated messages so multi-turn context is kept.
      const response = await result.response;
      if (response?.messages) this.history.push(...response.messages);
    } catch (err) {
      this.events.push({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.abortController = null;
    }
  }

  /** Abort the in-flight turn, if any. */
  abort(): void {
    this.abortController?.abort();
  }

  /** Close the event stream; call when the session is being torn down. */
  close(): void {
    this.abort();
    this.events.close();
  }

  private mapPart(part: { type: string; [key: string]: unknown }): void {
    switch (part.type) {
      case "text-delta":
        this.events.push({ type: "text-delta", text: part.text as string });
        break;
      case "tool-call":
        this.events.push({
          type: "tool-call-start",
          toolCallId: part.toolCallId as string,
          toolName: part.toolName as string,
          args: part.input,
        });
        break;
      case "tool-result":
        this.events.push({
          type: "tool-result",
          toolCallId: part.toolCallId as string,
          toolName: part.toolName as string,
          result: part.output,
          isError: false,
        });
        break;
      case "tool-error":
        this.events.push({
          type: "tool-result",
          toolCallId: part.toolCallId as string,
          toolName: part.toolName as string,
          result: part.error,
          isError: true,
        });
        break;
      case "finish-step":
        this.events.push({ type: "step-finish", stepNumber: ++this.stepCounter });
        break;
      case "error":
        this.events.push({ type: "error", message: String(part.error) });
        break;
      case "finish":
        this.events.push({
          type: "finish",
          reason: String(part.finishReason ?? "stop"),
          usage: mapUsage(part.totalUsage),
        });
        break;
      default:
        break; // start, text-start, tool-input-*, etc. are not surfaced
    }
  }
}

function mapUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, number | undefined>;
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    totalTokens: u.totalTokens,
  };
}
