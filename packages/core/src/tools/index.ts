import { tool, type ToolSet } from "ai";
import type { SessionEvent } from "@cozycode/protocol";
import type { PermissionGate } from "../permissions.ts";
import type { ToolContext, ToolDef } from "./types.ts";
import { readFileTool, writeFileTool, editFileTool } from "./fs.ts";
import { runShellTool } from "./shell.ts";
import { searchTool } from "./search.ts";

/**
 * Widened element type: each tool keeps its own inferred schema internally, but
 * a heterogeneous array must erase the schema generic. Function params are
 * contravariant, so a concrete-schema tool is not assignable to
 * `ToolDef<z.ZodTypeAny>`; `any` is the one parameterization that accepts them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDef = ToolDef<any>;

export const TOOL_DEFS: AnyToolDef[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  runShellTool,
  searchTool,
];

/** File-mutating tools that are hard-denied in plan mode. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
]);

export interface BuildToolsOptions {
  ctx: ToolContext;
  gate: PermissionGate;
  emit: (event: SessionEvent) => void;
}

/**
 * Adapt cozycode's ToolDefs into an AI SDK ToolSet, wrapping each `run` with
 * the permission gate. A denied call resolves to a structured denial (rather
 * than throwing) so the model can see it and adapt.
 */
export function buildTools({ ctx, gate, emit }: BuildToolsOptions): ToolSet {
  const set: ToolSet = {};
  for (const def of TOOL_DEFS) {
    set[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (rawArgs: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => {
        const args = def.inputSchema.parse(rawArgs);
        const { allowed, decision, message } = await gate.authorize({
          toolCallId: options.toolCallId,
          toolName: def.name,
          args,
          summary: def.summarize(args),
        });

        emit({
          type: "tool-approval",
          toolCallId: options.toolCallId,
          toolName: def.name,
          decision,
        });

        if (!allowed) {
          return {
            denied: true,
            message: message ?? `Permission denied: the user did not approve "${def.name}".`,
          };
        }

        return def.run(args, { ...ctx, abortSignal: options.abortSignal });
      },
    });
  }
  return set;
}
