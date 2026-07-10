import type { z } from "zod";
import type { AgentInfo, QuestionSpec } from "@cozycode/protocol";

/**
 * Spawn a subagent (child session) and resolve with its final assistant text.
 * Injected by the parent `Session` so the `task` tool never imports `Session`.
 */
export type SpawnSubagentFn = (opts: {
  agent: AgentInfo;
  prompt: string;
  description: string;
  parentToolCallId: string;
  signal?: AbortSignal;
}) => Promise<{ text: string; sessionId: string }>;

/** Runtime context handed to every tool's `run`. */
export interface ToolContext {
  /** Absolute workspace root; all file/shell/search access is rooted here. */
  workspaceRoot: string;
  /** Cancellation signal for the current turn. */
  abortSignal?: AbortSignal;
  /** Attach frontend-only presentation data to this tool call. */
  reportMetadata?: (metadata: Record<string, unknown>) => void;
  /** Ask the user questions and await answers (interactive tools only). */
  askUser?: (input: { questions: QuestionSpec[] }) => Promise<string[][]>;
  /** The AI SDK tool call id for the current call (used to correlate subagents). */
  toolCallId?: string;
  /** Agent definitions available to spawn (task tool only). */
  agents?: AgentInfo[];
  /** Spawn a subagent (task tool only). */
  spawnSubagent?: SpawnSubagentFn;
}

/**
 * A tool definition in cozycode's own shape. The registry adapts these into
 * AI SDK `tool()` objects and wraps `run` with the permission gate — so the
 * gate and the tool logic can be tested independently of the SDK.
 */
export interface ToolDef<Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: Schema;
  /**
   * Interactive tools handle their own user interaction (e.g. `ask_user`), so
   * the registry does NOT gate them through the permission service, and omits
   * them entirely from non-interactive (subagent) sessions.
   */
  interactive?: boolean;
  /** One-line description of what a concrete call will do (for approval UI). */
  summarize: (args: z.infer<Schema>) => string;
  run: (args: z.infer<Schema>, ctx: ToolContext) => Promise<unknown>;
}

/**
 * Author a tool with full type inference from its Zod schema. Without this the
 * schema type is erased and `summarize`/`run` receive `unknown` args.
 */
export function defineTool<Schema extends z.ZodTypeAny>(def: ToolDef<Schema>): ToolDef<Schema> {
  return def;
}
