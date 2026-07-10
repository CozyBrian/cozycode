import { z } from "zod";
import type { QuestionSpec } from "@cozycode/protocol";
import { defineTool } from "./types.ts";

const optionSchema = z.object({
  label: z.string().describe("Short selectable option label."),
  description: z.string().optional().describe("Optional longer explanation of the option."),
});

const questionSchema = z.object({
  question: z.string().describe("The full question to ask the user."),
  header: z.string().describe("A short label/title for this question (keep it under ~30 chars)."),
  options: z
    .array(optionSchema)
    .describe("Selectable options. The UI always also offers a free-text 'type your own answer' choice."),
  multiple: z.boolean().optional().describe("Allow the user to select more than one option."),
});

const inputSchema = z.object({
  questions: z
    .array(questionSchema)
    .min(1)
    .describe("One or more questions to ask the user, answered in sequence."),
});

/** Model-visible summary: one "question → answers" line per question. */
function formatQnA(questions: QuestionSpec[], answers: string[][]): string {
  return questions
    .map((q, i) => `${q.question} → ${(answers[i] ?? []).join(", ") || "(no answer)"}`)
    .join("\n");
}

/**
 * Lets the model ask the user one or more questions with selectable options and
 * block until answered. Interactive (not permission-gated) and unavailable to
 * subagents, which have no one to answer.
 */
export const askUserTool = defineTool({
  name: "ask_user",
  description:
    "Ask the user one or more multiple-choice questions and wait for their answer. " +
    "Use this when you need a decision or missing information before you can proceed. " +
    "Each question offers selectable options plus a free-text 'type your own answer' choice; " +
    "set `multiple: true` to allow selecting several options. Prefer this over guessing.",
  interactive: true,
  inputSchema,
  summarize: ({ questions }) =>
    questions.length === 1 ? `Ask: ${questions[0]!.header}` : `Ask ${questions.length} questions`,
  async run({ questions }, ctx) {
    if (!ctx.askUser) throw new Error("This session cannot ask the user questions.");
    const answers = await ctx.askUser({ questions });
    ctx.reportMetadata?.({ questions, answers });
    return { answers: formatQnA(questions, answers) };
  },
});
