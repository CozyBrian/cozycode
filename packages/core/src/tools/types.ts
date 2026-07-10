import type { z } from "zod";

/** Runtime context handed to every tool's `run`. */
export interface ToolContext {
  /** Absolute workspace root; all file/shell/search access is rooted here. */
  workspaceRoot: string;
  /** Cancellation signal for the current turn. */
  abortSignal?: AbortSignal;
  /** Attach frontend-only presentation data to this tool call. */
  reportMetadata?: (metadata: Record<string, unknown>) => void;
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
