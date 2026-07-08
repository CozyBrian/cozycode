import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ToolLoopAgent, isStepCount, type LanguageModel, type ModelMessage } from "ai";
import type {
  AgentMode,
  ApprovalHandler,
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
  PLAN_MODE_PROMPT_ADDENDUM,
  PLAN_FILE_DIR,
} from "./config.ts";

export interface SessionOptions {
  /** Inject a pre-built language model, bypassing provider-config construction. */
  model?: LanguageModel;
}

/**
 * A conversation with the coding agent. Owns the message history, the model,
 * the permission gate, and the tool set. `events` is a long-lived stream a
 * frontend consumes for the whole session; each `send()` drives one agent turn
 * and emits into that stream.
 */
export class Session {
  readonly id = randomUUID();
  readonly events = new AsyncEventQueue<SessionEvent>();

  private readonly history: ModelMessage[] = [];
  private readonly gate: PermissionGate;
  private readonly tools: ReturnType<typeof buildTools>;
  private agent: ToolLoopAgent;
  private currentModel: string;
  private currentMode: AgentMode;
  private abortController: AbortController | null = null;
  private stepCounter = 0;
  private planFilePath: string | null = null;
  // The model used to build the current agent, retained so a mode change can
  // rebuild with the same model rather than reconstructing the provider model.
  private activeModel: LanguageModel;

  constructor(
    private readonly config: SessionConfig,
    approvalHandler: ApprovalHandler,
    options: SessionOptions = {},
  ) {
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

    if (initialMode === "plan") {
      this.planFilePath = this.computePlanPath();
      this.gate.setPlanFile(this.planFilePath);
    }
  }

  /** The workspace-relative path to the plan markdown file, if plan mode has been entered. */
  get planFile(): string | null {
    return this.planFilePath;
  }

  private computePlanPath(): string {
    return join(PLAN_FILE_DIR, `${this.id}.md`);
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
   * Switch the agent mode mid-session. Rebuilds the agent with a mode-appropriate
   * system prompt and arms the permission gate's read-only enforcement. Emits a
   * `mode-change` event so frontends can render a transition marker.
   *
   * Entering plan mode also ensures the plan file directory exists and registers
   * the plan file path on the gate so the agent can write to it.
   */
  setMode(mode: AgentMode): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    this.gate.setMode(mode);
    if (mode === "plan") {
      this.planFilePath = this.computePlanPath();
      this.gate.setPlanFile(this.planFilePath);
      void mkdir(join(this.config.workspaceRoot, PLAN_FILE_DIR), {
        recursive: true,
      }).catch(() => {});
    }
    this.agent = this.buildAgent(this.activeModel);
    this.events.push({ type: "mode-change", mode });
  }

  private buildAgent(model: LanguageModel): ToolLoopAgent {
    let instructions: string;
    if (this.currentMode === "plan") {
      const planInfo = this.planFilePath
        ? `Write your implementation plan to ${this.planFilePath}.`
        : `No plan file path is set.`;
      instructions = `${this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT} ${PLAN_MODE_PROMPT_ADDENDUM} ${planInfo}`;
    } else if (this.planFilePath) {
      instructions = [
        "You are now in build mode — execute the implementation plan.",
        `Read the plan file at ${this.planFilePath} and follow it step by step.`,
        "Work in small, verifiable steps. Prefer reading a file before editing it.",
        "When you edit code, make targeted changes and explain what you did.",
        "If you encounter any deviation from the plan, update the plan file to reflect",
        "the actual implementation so the plan stays accurate.",
      ].join(" ");
    } else {
      instructions = this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    }
    return new ToolLoopAgent({
      model,
      instructions,
      tools: this.tools,
      stopWhen: isStepCount(this.config.maxSteps ?? DEFAULT_MAX_STEPS),
    });
  }

  /** Run one agent turn for the given user message. Resolves when the turn ends. */
  async send(userMessage: string): Promise<void> {
    this.history.push({ role: "user", content: userMessage });
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
