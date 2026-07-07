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

// ── Permissions ──────────────────────────────────────────────────────────────

/** The three outcomes the permission gate can resolve to for a tool call. */
export type PermissionDecision = "allow" | "ask" | "deny";

/** Per-tool policy. Unlisted tools fall back to `defaultDecision`. */
export interface PermissionPolicy {
  defaultDecision: PermissionDecision;
  tools: Record<string, PermissionDecision>;
  /**
   * Decision for shell commands classified as "destructive" (e.g. `rm`,
   * `git reset`, `npm install`). Defaults to `"ask"`. When set to `"deny"`,
   * destructive commands are blocked outright without prompting.
   * Only applies when `run_shell` policy resolves to `"ask"`.
   */
  shellDestructiveDecision?: PermissionDecision;
}

/**
 * A request surfaced to the frontend when a tool's policy resolves to `ask`.
 * The frontend renders it (e.g. an approval modal) and replies with an
 * `ApprovalResponse`.
 */
export interface ApprovalRequest {
  /** Correlates the request with its response across a transport boundary. */
  requestId: string;
  toolCallId: string;
  toolName: string;
  /** The tool's validated input arguments. */
  args: unknown;
  /** Short human-readable description of what the tool is about to do. */
  summary: string;
}

export type ApprovalOutcome =
  | "allow-once"
  | "allow-session" // remember: allow this tool for the rest of the session
  | "deny";

export interface ApprovalResponse {
  requestId: string;
  outcome: ApprovalOutcome;
}

/** The callback a frontend supplies to answer `ask` decisions. */
export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalOutcome>;

// ── Session event stream ─────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type SessionEvent =
  | { type: "session-start"; sessionId: string }
  | { type: "text-delta"; text: string }
  | {
      type: "tool-call-start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool-approval"; // emitted for observability; the decision flows via ApprovalHandler
      toolCallId: string;
      toolName: string;
      decision: PermissionDecision;
    }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | { type: "step-finish"; stepNumber: number }
  | { type: "error"; message: string }
  | { type: "finish"; reason: string; usage?: TokenUsage };

// ── Config ───────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  /** Provider label, e.g. "openai", "openrouter", "local". */
  name: string;
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
  /** Per-tool permission policy. */
  permissions: PermissionPolicy;
  /** Hard cap on agent steps per turn. */
  maxSteps?: number;
}
