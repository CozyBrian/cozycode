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
import type { QuestionService } from "../question/service.ts";
import type { AgentInfo } from "@cozycode/protocol";
import type { SpawnSubagentFn, ToolContext, ToolDef } from "./types.ts";
import { readFileTool, writeFileTool, editFileTool } from "./fs.ts";
import { runShellTool } from "./shell.ts";
import { searchTool } from "./search.ts";
import { askUserTool } from "./ask-user.ts";
import { createTaskTool } from "./task.ts";
import { webFetchTool } from "./webfetch.ts";
import { webSearchTool } from "./websearch.ts";
import { todoWriteTool } from "./todo.ts";
import { applyPatchTool } from "./apply-patch.ts";

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
  applyPatchTool,
  runShellTool,
  searchTool,
  webFetchTool,
  webSearchTool,
  todoWriteTool,
  askUserTool,
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
    case "apply_patch": {
      const patch: string = args.patchText ?? "";
      const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim());
      return {
        permission: "edit",
        patterns: paths.length ? paths : ["*"],
        always: ["*"],
        metadata: { summary },
      };
    }
    case "webfetch":
      return { permission: "webfetch", patterns: [args.url ?? "*"], always: ["*"], metadata: { summary, url: args.url } };
    case "websearch":
      return { permission: "websearch", patterns: [args.query ?? "*"], always: ["*"], metadata: { summary, query: args.query } };
    case "todowrite":
      return { permission: "todowrite", patterns: ["*"], always: ["*"], metadata: { summary } };
    case "run_shell": {
      const command: string = args.command ?? "";
      const { patterns, always } = commandPatterns(command);
      return { permission: "bash", patterns, always, metadata: { summary, command } };
    }
    case "task":
      return {
        permission: "task",
        patterns: [args.subagent_type ?? "*"],
        always: [args.subagent_type ?? "*"],
        metadata: { summary, subagent_type: args.subagent_type },
      };
    default:
      return { permission: toolName, patterns: ["*"], always: ["*"], metadata: { summary, args } };
  }
}

export interface BuildToolsOptions {
  ctx: ToolContext;
  permissions: PermissionService;
  questions: QuestionService;
  getMode: () => AgentMode;
  reportToolMetadata: (toolCallId: string, metadata: Record<string, unknown>) => void;
  /**
   * When false, interactive tools (e.g. `ask_user`) are omitted — used for
   * subagent sessions that have no one to answer.
   */
  interactive?: boolean;
  /** Agent definitions available to spawn; enables the `task` tool when non-empty. */
  agents?: AgentInfo[];
  /** Spawn capability injected by the Session; absent for subagent sessions. */
  spawnSubagent?: SpawnSubagentFn;
}

/**
 * Adapt cozycode's ToolDefs into an AI SDK ToolSet, gating each `run` through
 * the permission service. A denied/rejected call resolves to a structured
 * denial (rather than throwing) so the model can see it and adapt.
 *
 * Interactive tools handle their own user interaction, so they bypass the
 * permission gate and are omitted from non-interactive sessions. The `task`
 * tool is appended only when a spawn capability + non-primary agents exist, so
 * subagent sessions (which get neither) cannot recurse.
 */
export function buildTools(options: BuildToolsOptions): ToolSet {
  const { ctx, permissions, questions, getMode, reportToolMetadata } = options;
  const interactive = options.interactive ?? true;
  const agents = options.agents ?? [];

  const defs: AnyToolDef[] = [...TOOL_DEFS];
  if (options.spawnSubagent && agents.some((a) => a.mode !== "primary")) {
    defs.push(createTaskTool(agents));
  }

  const set: ToolSet = {};
  for (const def of defs) {
    if (def.interactive && !interactive) continue;
    set[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (rawArgs: unknown, callOptions: { toolCallId: string; abortSignal?: AbortSignal }) => {
        const args = def.inputSchema.parse(rawArgs);

        // Interactive tools do their own user interaction; skip the permission gate.
        if (!def.interactive) {
          const request = describePermission(def.name, args, def.summarize(args));
          try {
            await permissions.ask({
              ...request,
              tool: { callId: callOptions.toolCallId, toolName: def.name },
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
        }

        return def.run(args, {
          ...ctx,
          abortSignal: callOptions.abortSignal,
          reportMetadata: (metadata) => reportToolMetadata(callOptions.toolCallId, metadata),
          toolCallId: callOptions.toolCallId,
          askUser: (input) =>
            questions.ask({ ...input, tool: { callId: callOptions.toolCallId, toolName: def.name } }),
          agents,
          spawnSubagent: options.spawnSubagent,
        });
      },
    });
  }
  return set;
}
