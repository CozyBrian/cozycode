import { z } from "zod";
import type { AgentInfo } from "@cozycode/protocol";
import { defineTool, type ToolDef } from "./types.ts";

/**
 * Build the `task` tool for the given agent registry. Built dynamically (rather
 * than a static `TOOL_DEFS` entry) so the available subagent types can be listed
 * in the description at construction time, mirroring opencode's `describeTask`.
 */
export function createTaskTool(agents: AgentInfo[]): ToolDef {
  const spawnable = agents.filter((a) => a.mode !== "primary" && !a.hidden);
  const list = spawnable.map((a) => `- ${a.name}: ${a.description ?? ""}`).join("\n");

  return defineTool({
    name: "task",
    description:
      "Delegate a well-scoped task to a subagent that runs its own tool loop in an isolated " +
      "session and returns a final text result. Use it for focused research, broad searches, " +
      "or parallelizable work you don't need to supervise step by step.\n\n" +
      "Available subagent types:\n" +
      list,
    inputSchema: z.object({
      description: z.string().describe("A short (3-5 word) description of the task."),
      prompt: z.string().describe("The complete, self-contained instructions for the subagent."),
      subagent_type: z.string().describe("Which subagent type to spawn (see the list above)."),
    }),
    summarize: (args) => `Delegate to ${args.subagent_type}: ${args.description}`,
    async run(args, ctx) {
      const agent = ctx.agents?.find((a) => a.name === args.subagent_type && a.mode !== "primary");
      if (!agent) {
        return { error: `Unknown subagent type "${args.subagent_type}".` };
      }
      if (!ctx.spawnSubagent || !ctx.toolCallId) {
        return { error: "Subagents are not available in this session." };
      }
      const { text } = await ctx.spawnSubagent({
        agent,
        prompt: args.prompt,
        description: args.description,
        parentToolCallId: ctx.toolCallId,
        signal: ctx.abortSignal,
      });
      return { agent: agent.name, result: text };
    },
  });
}
