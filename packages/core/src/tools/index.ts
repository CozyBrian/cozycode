import { tool, type ToolSet } from "ai";
import type { AgentMode } from "@cozycode/protocol";
import {
  PermissionCorrectedError,
  PermissionDeniedError,
  PermissionRejectedError,
  type AskInput,
  type PermissionService,
} from "../permission/service.ts";
import { commandPatterns } from "../permission/bash-patterns.ts";
import { PLAN_MODE_DENIAL_MESSAGE } from "../config.ts";
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

/**
 * Map a tool call to the permission category, patterns, and "always" grants it
 * should be evaluated against. `edit` covers both write/edit; `bash` derives
 * per-command patterns and prefix-glob "always" grants from the command text.
 */
function describePermission(
  toolName: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any,
  summary: string,
): AskInput {
  switch (toolName) {
    case "read_file":
      return { permission: "read", patterns: [args.path], always: ["*"], metadata: { summary, path: args.path } };
    case "search":
      return {
        permission: "search",
        patterns: [args.pattern ?? args.glob ?? "*"],
        always: ["*"],
        metadata: { summary, args },
      };
    case "write_file":
    case "edit_file":
      return { permission: "edit", patterns: [args.path], always: ["*"], metadata: { summary, path: args.path } };
    case "run_shell": {
      const command: string = args.command ?? "";
      const { patterns, always } = commandPatterns(command);
      return { permission: "bash", patterns, always, metadata: { summary, command } };
    }
    default:
      return { permission: toolName, patterns: ["*"], always: ["*"], metadata: { summary, args } };
  }
}

export interface BuildToolsOptions {
  ctx: ToolContext;
  permissions: PermissionService;
  getMode: () => AgentMode;
}

/**
 * Adapt cozycode's ToolDefs into an AI SDK ToolSet, gating each `run` through
 * the permission service. A denied/rejected call resolves to a structured
 * denial (rather than throwing) so the model can see it and adapt.
 */
export function buildTools({ ctx, permissions, getMode }: BuildToolsOptions): ToolSet {
  const set: ToolSet = {};
  for (const def of TOOL_DEFS) {
    set[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (rawArgs: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => {
        const args = def.inputSchema.parse(rawArgs);
        const request = describePermission(def.name, args, def.summarize(args));

        try {
          await permissions.ask({
            ...request,
            tool: { callId: options.toolCallId, toolName: def.name },
          });
        } catch (err) {
          // In plan mode an edit is denied by the plan overlay; surface the
          // plan-specific guidance rather than the raw rule message.
          if (
            err instanceof PermissionDeniedError &&
            getMode() === "plan" &&
            request.permission === "edit"
          ) {
            return { denied: true, message: PLAN_MODE_DENIAL_MESSAGE };
          }
          if (
            err instanceof PermissionDeniedError ||
            err instanceof PermissionRejectedError ||
            err instanceof PermissionCorrectedError
          ) {
            return { denied: true, message: err.message };
          }
          throw err;
        }

        return def.run(args, { ...ctx, abortSignal: options.abortSignal });
      },
    });
  }
  return set;
}
