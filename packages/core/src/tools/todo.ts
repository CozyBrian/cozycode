import { z } from "zod";
import { defineTool } from "./types.ts";

const todoSchema = z.object({
  content: z.string().describe("Brief description of the task."),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("Current status of the task."),
  priority: z.enum(["high", "medium", "low"]).optional().describe("Task priority."),
});

/**
 * Maintains the agent's task checklist. The model sends the FULL list each call
 * (replacing the previous one); the current list is shown to the user as a
 * checklist. Keep exactly one task `in_progress` at a time.
 */
export const todoWriteTool = defineTool({
  name: "todowrite",
  description:
    "Create and update a structured task list for the current work. Send the " +
    "entire list every time (it replaces the previous one). Use it to plan and " +
    "track multi-step work; mark a task in_progress before starting it and " +
    "completed as soon as it's done. Keep one task in_progress at a time.",
  inputSchema: z.object({
    todos: z.array(todoSchema).describe("The full, updated todo list."),
  }),
  summarize: ({ todos }) => {
    const open = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length;
    return `Update todos (${open} open / ${todos.length} total)`;
  },
  async run({ todos }, ctx) {
    ctx.reportMetadata?.({ todos });
    return { todos };
  },
});
