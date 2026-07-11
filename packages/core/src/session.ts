import { randomUUID } from "node:crypto";
import { ToolLoopAgent, isStepCount, type LanguageModel, type ModelMessage } from "ai";
import type {
  AgentInfo,
  AgentMode,
  PermissionReply,
  PermissionRequest,
  QuestionRequest,
  Ruleset,
  SessionConfig,
  SessionEvent,
  TokenUsage,
} from "@cozycode/protocol";
import { createModel } from "./model.ts";
import { reasoningProviderOptions } from "./reasoning.ts";
import { generateSessionTitle } from "./title.ts";
import { PermissionService } from "./permission/service.ts";
import { QuestionService } from "./question/service.ts";
import { DEFAULT_RULESET, PLAN_RULESET, mergeRulesets } from "./permission/config.ts";
import { deriveSubagentRuleset } from "./agents.ts";
import { buildTools } from "./tools/index.ts";
import type { SpawnSubagentFn } from "./tools/types.ts";
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
  /** Agent registry; enables the `task` tool for primary sessions. */
  agents?: AgentInfo[];
  /** Marks this as a subagent (child) session: no interactive tools, no `task` tool. */
  isSubagent?: boolean;
  /** Test hook: build a child model for a spawned subagent (bypasses the provider). */
  spawnModel?: (agent: AgentInfo) => LanguageModel | undefined;
  /** Optional title-model candidates, tried before this session's active model. */
  titleModels?: LanguageModel[];
}

/**
 * A conversation with the coding agent. Owns the message history, the model,
 * the permission service, and the tool set. `events` is a long-lived stream a
 * frontend consumes for the whole session; each `send()` drives one agent turn
 * and emits into that stream.
 */
export class Session {
  readonly id: string;
  readonly events = new AsyncEventQueue<SessionEvent>();

  private readonly history: ModelMessage[] = [];
  /** The base (build-mode) ruleset; the plan overlay is applied per mode. */
  private baseRuleset: Ruleset;
  private readonly permissions: PermissionService;
  private readonly questions: QuestionService;
  private readonly tools: ReturnType<typeof buildTools>;
  private readonly toolMetadata = new Map<string, Record<string, unknown>>();
  /** Live child (subagent) sessions, so a parent abort tears them down. */
  private readonly children = new Map<string, Session>();
  private agent: ToolLoopAgent;
  private currentModel: string;
  private currentMode: AgentMode;
  private currentEffort: string | undefined;
  private abortController: AbortController | null = null;
  private stepCounter = 0;
  private hadPlanTurn = false;
  private buildSwitchPending = false;
  /** Start time (ms) per in-flight reasoning block id, for duration reporting. */
  private readonly reasoningStarts = new Map<string, number>();
  // The model used to build the current agent, retained so a mode change can
  // rebuild with the same model rather than reconstructing the provider model.
  private activeModel: LanguageModel;
  /** Test hook: build a child model for a spawned subagent. */
  private subagentSpawnModel?: (agent: AgentInfo) => LanguageModel | undefined;
  private readonly titleModels?: LanguageModel[];
  private readonly isSubagent: boolean;
  private readonly titleEligible: boolean;
  private titleStarted = false;

  /**
   * Spawn a subagent as an isolated child `Session`, funnel its events up this
   * session's queue (wrapped), and resolve with its final assistant text. The
   * parent is the sole consumer of the child's queue; child permission asks are
   * auto-rejected (a subagent has no one to prompt). Defined as a bound field so
   * it can be injected into `buildTools` without leaking `Session` into tools.
   */
  private readonly spawnSubagent: SpawnSubagentFn = async ({
    agent,
    prompt,
    description,
    parentToolCallId,
    signal,
  }) => {
    const childConfig: SessionConfig = {
      ...this.config,
      model: agent.model?.modelID ?? this.currentModel,
      systemPrompt: agent.prompt ?? this.config.systemPrompt,
      permissions: deriveSubagentRuleset(this.baseRuleset, agent),
      mode: "build",
      maxSteps: agent.steps ?? this.config.maxSteps,
      reasoningEffort: this.currentEffort,
    };
    const injected = this.subagentSpawnModel?.(agent);
    const child = new Session(childConfig, {
      isSubagent: true,
      ...(injected ? { model: injected } : {}),
    });
    this.children.set(child.id, child);
    this.events.push({
      type: "subagent-start",
      toolCallId: parentToolCallId,
      sessionId: child.id,
      agent: agent.name,
      description,
    });

    let text = "";
    const pump = (async () => {
      for await (const event of child.events) {
        if (event.type === "text-delta") text += event.text;
        // Subagents can't prompt the user: auto-reject any permission ask.
        if (event.type === "permission-asked") {
          child.replyPermission(event.request.id, "reject", "Subagents cannot request interactive permission.");
        }
        this.events.push({
          type: "subagent-event",
          toolCallId: parentToolCallId,
          sessionId: child.id,
          event,
        });
      }
    })();

    const onAbort = () => child.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      await child.send(prompt);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      child.close(); // closes child.events → the pump loop drains and ends
      await pump;
      this.children.delete(child.id);
    }
    this.events.push({
      type: "subagent-finish",
      toolCallId: parentToolCallId,
      sessionId: child.id,
      result: text,
    });
    return { text, sessionId: child.id };
  };

  constructor(
    private readonly config: SessionConfig,
    options: SessionOptions = {},
  ) {
    this.id = options.id ?? randomUUID();
    if (options.initialHistory?.length) this.history.push(...options.initialHistory);
    const initialMode = config.mode ?? "build";
    this.currentMode = initialMode;
    this.baseRuleset = config.permissions ?? DEFAULT_RULESET;
    this.permissions = new PermissionService(
      this.effectiveRuleset(initialMode),
      this.id,
      (e) => this.events.push(e),
    );
    this.questions = new QuestionService(this.id, (e) => this.events.push(e));
    const isSubagent = options.isSubagent ?? false;
    this.isSubagent = isSubagent;
    this.titleModels = options.titleModels;
    this.titleEligible = !isSubagent && !options.initialHistory?.some((message) => message.role === "user");
    this.subagentSpawnModel = options.spawnModel;
    this.tools = buildTools({
      ctx: { workspaceRoot: config.workspaceRoot },
      permissions: this.permissions,
      questions: this.questions,
      getMode: () => this.currentMode,
      reportToolMetadata: (toolCallId, metadata) => this.toolMetadata.set(toolCallId, metadata),
      // Subagents have no one to answer prompts and must not recurse.
      interactive: !isSubagent,
      agents: isSubagent ? [] : (options.agents ?? []),
      spawnSubagent: isSubagent ? undefined : this.spawnSubagent,
    });
    this.currentModel = config.model;
    this.currentEffort = config.reasoningEffort;
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

  /** The reasoning effort currently in effect (undefined = provider default). */
  get reasoningEffort(): string | undefined {
    return this.currentEffort;
  }

  /**
   * A deep copy of the conversation history, suitable for persisting and later
   * seeding a new session via `SessionOptions.initialHistory`.
   */
  snapshotHistory(): ModelMessage[] {
    return structuredClone(this.history);
  }

  /**
   * The ruleset actually in force for a mode: plan mode overlays the plan
   * ruleset (deny edits) on top of the base; build mode uses the base as-is.
   */
  private effectiveRuleset(mode: AgentMode): Ruleset {
    return mode === "plan" ? mergeRulesets(this.baseRuleset, PLAN_RULESET) : this.baseRuleset;
  }

  /** Replace the base permission ruleset live (e.g. switching a permission preset). */
  setPermissions(ruleset: Ruleset): void {
    this.baseRuleset = ruleset;
    this.permissions.setRuleset(this.effectiveRuleset(this.currentMode));
  }

  /** Answer a pending permission ask. Safe to call with an unknown/stale id. */
  replyPermission(requestId: string, reply: PermissionReply, message?: string): void {
    this.permissions.reply(requestId, reply, message);
  }

  /** The permission asks currently awaiting a decision (for UI resync). */
  pendingPermissions(): PermissionRequest[] {
    return this.permissions.listPending();
  }

  /** Answer a pending `ask_user` question. Safe to call with an unknown/stale id. */
  answerQuestion(requestId: string, answers: string[][]): void {
    this.questions.answer(requestId, answers);
  }

  /** Decline a pending question (user cancelled). Surfaces as an error to the model. */
  rejectQuestion(requestId: string, message?: string): void {
    this.questions.reject(requestId, message);
  }

  /** The questions currently awaiting an answer (for UI resync). */
  pendingQuestions(): QuestionRequest[] {
    return this.questions.listPending();
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
    this.permissions.setRuleset(this.effectiveRuleset(mode));
    this.events.push({ type: "mode-change", mode });
  }

  /**
   * Change the reasoning effort mid-session. Rebuilds the agent (the AI SDK
   * only accepts `providerOptions` at construction) while keeping the same
   * model and history, then emits `effort-change` for frontends.
   */
  setReasoningEffort(effort: string | undefined): void {
    if (effort === this.currentEffort) return;
    this.currentEffort = effort;
    this.agent = this.buildAgent(this.activeModel);
    this.events.push({ type: "effort-change", effort });
  }

  private buildAgent(model: LanguageModel): ToolLoopAgent {
    const providerOptions = reasoningProviderOptions(this.config.provider, this.currentEffort);
    return new ToolLoopAgent({
      model,
      instructions: this.config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      tools: this.tools,
      stopWhen: isStepCount(this.config.maxSteps ?? DEFAULT_MAX_STEPS),
      ...(providerOptions ? { providerOptions } : {}),
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
    if (this.titleEligible && !this.titleStarted && this.titleModels) {
      this.titleStarted = true;
      void generateSessionTitle([...this.titleModels, this.activeModel], userMessage).then((title) => {
        if (title) this.events.push({ type: "title-change", title });
      });
    }
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

  /** Abort the in-flight turn, if any. Also rejects any parked permission/question asks. */
  abort(): void {
    this.abortController?.abort();
    // Without this, a tool call parked on a pending ask stays suspended forever
    // even after the stream is aborted, keeping the turn open.
    this.permissions.rejectAll();
    this.questions.rejectAll();
    // Cascade to any live subagents so their turns end too.
    for (const child of this.children.values()) child.abort();
  }

  /** Close the event stream; call when the session is being torn down. */
  close(): void {
    this.abort();
    // rejectAll() (via abort) pushed the replied events; the queue buffers them
    // so consumers drain them before seeing done.
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
      {
        const toolCallId = part.toolCallId as string;
        this.events.push({
          type: "tool-result",
          toolCallId,
          toolName: part.toolName as string,
          result: part.output,
          isError: false,
          metadata: this.toolMetadata.get(toolCallId),
        });
        this.toolMetadata.delete(toolCallId);
      }
        break;
      case "tool-error":
      {
        const toolCallId = part.toolCallId as string;
        this.events.push({
          type: "tool-result",
          toolCallId,
          toolName: part.toolName as string,
          result: part.error,
          isError: true,
          metadata: this.toolMetadata.get(toolCallId),
        });
        this.toolMetadata.delete(toolCallId);
      }
        break;
      case "reasoning-start":
        this.reasoningStarts.set(part.id as string, Date.now());
        this.events.push({ type: "reasoning-start", id: part.id as string });
        break;
      case "reasoning-delta":
        this.events.push({
          type: "reasoning-delta",
          id: part.id as string,
          text: part.text as string,
        });
        break;
      case "reasoning-end": {
        const id = part.id as string;
        const started = this.reasoningStarts.get(id);
        this.reasoningStarts.delete(id);
        this.events.push({
          type: "reasoning-end",
          id,
          durationMs: started !== undefined ? Date.now() - started : undefined,
        });
        break;
      }
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
