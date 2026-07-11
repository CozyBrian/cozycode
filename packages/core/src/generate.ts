import { generateText, type LanguageModel } from "ai";

/** Run a single non-session generation through a configured model. */
export async function generateModelText(model: LanguageModel, prompt: string): Promise<string> {
  const result = await generateText({ model, prompt });
  return result.text;
}
