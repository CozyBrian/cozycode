/**
 * @cozycode/protocol
 *
 * The shared contract between the headless core engine and every frontend
 * (Electron desktop, TUI). These types are transport-agnostic: they describe
 * the event stream a session emits and the approval round-trip a frontend must
 * answer, so the same core can be embedded in-process or spoken to over IPC.
 */

// ── Messages ────────────────────────────────────────────────────────────────

export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  role: Role;
  content: string;
}

// ── Providers and models ────────────────────────────────────────────────────

export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutput?: number;
  cost?: { input: number; output: number };
  /** models.dev reasoning capability flag. */
  reasoning?: boolean;
  /**
   * Ordered reasoning-effort levels (weakest → strongest) this model accepts.
   * Empty or absent means the model exposes no effort control; frontends hide
   * the effort UI in that case.
   */
  reasoningEfforts?: string[];
}

export interface AuthMethodInfo {
  type: "oauth" | "api";
  label: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  models: ModelInfo[];
  authMethods: AuthMethodInfo[];
  source: "builtin" | "custom";
}

export interface ProviderList {
  all: ProviderInfo[];
  connected: string[];
  defaultModel?: ModelRef;
}

export interface OAuthStart {
  attemptID: string;
  url: string;
  instructions?: string;
  deviceCode?: string;
}

export type OAuthResult =
  | { status: "complete" }
  | { status: "failed"; message?: string }
  | { status: "cancelled" };

export interface CustomProviderInput {
  id: string;
  name?: string;
  baseURL: string;
  apiKey?: string;
  models?: string[];
}

// ── Permissions ──────────────────────────────────────────────────────────────
//
// Modeled on opencode's rule-based permission system. A rule matches a
// `permission` category (e.g. "edit", "bash", "read") and a `pattern`
// (a wildcard over the concrete resource — a file path, a shell command, …).
// Rules are evaluated last-match-wins, so later rules override earlier ones.

export type PermissionAction = "allow" | "deny" | "ask";

/** One rule: `permission` is the category, `pattern` a wildcard over the resource. */
export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

/** An ordered rule list. Evaluation is LAST match wins (later rules override). */
export type Ruleset = PermissionRule[];

/**
 * A pending permission ask, surfaced to frontends via the `permission-asked`
 * event. The frontend renders it and replies via the `permission-reply`
 * transport with a `PermissionReply`.
 */
export interface PermissionRequest {
  /** Ascending id ("per_<n>"); correlates the ask with its reply. */
  id: string;
  sessionId: string;
  /** The category being asked, e.g. "edit" | "bash" | "read" | "search". */
  permission: string;
  /** The concrete resources being evaluated (exact commands, file paths, …). */
  patterns: string[];
  /** Display payload for the frontend: { summary, command?, path?, args? }. */
  metadata: Record<string, unknown>;
  /** Patterns an "always" reply would grant, e.g. ["git commit *"]. Empty = no always option. */
  always: string[];
  tool?: { callId: string; toolName: string };
}

export type PermissionReply = "once" | "always" | "reject";

export interface PermissionReplyBody {
  requestId: string;
  reply: PermissionReply;
  /** Optional feedback on reject; surfaced to the model as correction feedback. */
  message?: string;
}

// ── Permission config-file surface (opencode style) ───────────────────────────
//
// A bare action ("allow") normalizes to { "*": "allow" }. An object maps a
// category to either an action (applies to every pattern) or a per-pattern map.
// Key order is preserved and is significant: precedence is last-match-wins.

export type PermissionConfigRule = PermissionAction | Record<string, PermissionAction>;
export type PermissionConfig =
  | PermissionAction
  | { [permission: string]: PermissionConfigRule };

// ── Agent mode ───────────────────────────────────────────────────────────────

/**
 * The agent's operating mode.
 *   - `build` — the default; tools run per the configured permission ruleset.
 *   - `plan`  — read-only research mode. A plan-mode ruleset overlay denies
 *               file-mutating tools regardless of the base ruleset. Use it to
 *               investigate and propose a plan without touching the workspace.
 */
export type AgentMode = "build" | "plan";

// ── Interactive questions ──────────────────────────────────────────────────────
//
// The model can ask the user one or more questions and block on the answers,
// mirroring the permission round-trip: a `question-asked` event carries the
// request, the frontend renders a prompt, and it replies via a `QuestionReplyBody`.

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionSpec {
  /** The full question text. */
  question: string;
  /** A short label/title for the question (shown as a step/tab header). */
  header: string;
  /** Selectable options; the UI always also offers a free-text "type your own" choice. */
  options: QuestionOption[];
  /** Allow selecting more than one option. */
  multiple?: boolean;
}

export interface QuestionRequest {
  /** Ascending id ("qst_<n>"); correlates the ask with its reply. */
  id: string;
  sessionId: string;
  questions: QuestionSpec[];
  tool?: { callId: string; toolName: string };
}

export interface QuestionReplyBody {
  requestId: string;
  /** Per-question arrays of chosen/typed values; `null` declines (rejects) the ask. */
  answers: string[][] | null;
}

// ── Agents ─────────────────────────────────────────────────────────────────────

/**
 * A named agent definition. `primary` agents are user-selectable top-level modes;
 * `subagent` agents are only invocable via the `task` tool; `all` is both.
 * Built-ins ship in core; `config` agents load from markdown-with-frontmatter.
 */
export interface AgentInfo {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  /** Pinned model; when absent the subagent inherits the parent's model. */
  model?: ModelRef;
  /** System-prompt override for the agent. */
  prompt?: string;
  /** Permission policy (from frontmatter `tools`/`permission`). */
  permission?: PermissionConfig;
  temperature?: number;
  /** Per-agent cap on agentic steps per turn. */
  steps?: number;
  hidden?: boolean;
  color?: string;
  source: "builtin" | "config";
}

// ── Session event stream ─────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type SessionEvent =
  | { type: "session-start"; sessionId: string }
  /** A generated title for the session's first real user turn. */
  | { type: "title-change"; title: string }
  | { type: "text-delta"; text: string }
  | {
      type: "tool-call-start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
      /** Frontend-only display data; never returned to the model as tool output. */
      metadata?: Record<string, unknown>;
    }
  | { type: "step-finish"; stepNumber: number }
  | { type: "error"; message: string }
  | { type: "mode-change"; mode: AgentMode }
  /** The active reasoning effort changed (undefined = provider default). */
  | { type: "effort-change"; effort?: string }
  /** A reasoning/thinking block began streaming. */
  | { type: "reasoning-start"; id: string }
  /** Incremental reasoning text for the block with matching `id`. */
  | { type: "reasoning-delta"; id: string; text: string }
  /** A reasoning block finished; `durationMs` is wall-clock time if known. */
  | { type: "reasoning-end"; id: string; durationMs?: number }
  /** A tool call is awaiting the user's permission decision. */
  | { type: "permission-asked"; request: PermissionRequest }
  /** A pending permission ask was resolved (by the user, or by cascade/always). */
  | { type: "permission-replied"; requestId: string; reply: PermissionReply }
  /** The model is asking the user one or more questions and awaiting answers. */
  | { type: "question-asked"; request: QuestionRequest }
  /** A pending question was answered (per-question arrays of chosen/typed values). */
  | { type: "question-answered"; requestId: string; answers: string[][] }
  /** A pending question was declined (user cancelled, or turn aborted). */
  | { type: "question-rejected"; requestId: string }
  /** A subagent (child session) was spawned by a `task` tool call. */
  | { type: "subagent-start"; toolCallId: string; sessionId: string; agent: string; description: string }
  /** A child session event, wrapped so the parent frontend can render it nested. */
  | { type: "subagent-event"; toolCallId: string; sessionId: string; event: SessionEvent }
  /** A subagent finished; `result` is its final assistant text. */
  | { type: "subagent-finish"; toolCallId: string; sessionId: string; result: string; isError?: boolean }
  | { type: "finish"; reason: string; usage?: TokenUsage };

// ── Config ───────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  /** Provider label, e.g. "openai", "openrouter", "local". */
  name: string;
  /** Selects a provider-specific transport when credentials require one. */
  kind?: "openai-compatible" | "openai" | "openai-oauth";
  /** OpenAI-compatible base URL, e.g. "https://api.openai.com/v1". */
  baseURL: string;
  /** API key; may be empty for local endpoints that don't require one. */
  apiKey?: string;
  /** Optional extra headers sent with every request. */
  headers?: Record<string, string>;
}

export interface SessionConfig {
  provider: ProviderConfig;
  /** Model id understood by the provider, e.g. "gpt-4o", "llama3.1". */
  model: string;
  /**
   * Optional explicit list of selectable model ids. When omitted, frontends
   * may discover models from the provider (e.g. its `/models` endpoint).
   */
  models?: string[];
  /** Absolute path the agent's tools are rooted at (its workspace). */
  workspaceRoot: string;
  /** Optional system prompt override. */
  systemPrompt?: string;
  /**
   * Fully-resolved base permission ruleset. Optional; when omitted, core uses
   * its `DEFAULT_RULESET`. The plan-mode overlay is applied by the Session per
   * mode, so callers pass only the base (build-mode) ruleset here.
   */
  permissions?: Ruleset;
  /** Initial agent mode; defaults to "build" when omitted. */
  mode?: AgentMode;
  /**
   * Initial reasoning effort. Only meaningful for models whose
   * `ModelInfo.reasoningEfforts` is non-empty; undefined = provider default.
   */
  reasoningEffort?: string;
  /** Hard cap on agent steps per turn. */
  maxSteps?: number;
}
