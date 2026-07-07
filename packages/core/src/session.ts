import { randomUUID } from "node:crypto";
import { ToolLoopAgent, isStepCount, type LanguageModel, type ModelMessage } from "ai";
import type {
  ApprovalHandler,
  SessionConfig,
  SessionEvent,
  TokenUsage,
} from "@cozycode/protocol";
import { createModel } from "./model.ts";
import { PermissionGate } from "./permissions.ts";
import { buildTools } from "./tools/index.ts";
import { AsyncEventQueue } from "./events.ts";
import { DEFAULT_MAX_STEPS, DEFAULT_SYSTEM_PROMPT } from "./config.ts";

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
  private readonly agent: ToolLoopAgent;
  private abortController: AbortController | null = null;
  private stepCounter = 0;

  constructor(
    private readonly config: SessionConfig,
    approvalHandler: ApprovalHandler,
    options: SessionOptions = {},
  ) {
    this.gate = new PermissionGate(config.permissions, approvalHandler);
    // A pre-built model can be injected (tests, custom wrapping); otherwise we
    // build one from the provider config.
    const model = options.model ?? createModel(config.provider, config.model);
    const tools = buildTools({
      ctx: { workspaceRoot: config.workspaceRoot },
      gate: this.gate,
      emit: (e) => this.events.push(e),
    });
    this.agent = new ToolLoopAgent({
      model,
      instructions: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      tools,
      stopWhen: isStepCount(config.maxSteps ?? DEFAULT_MAX_STEPS),
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
