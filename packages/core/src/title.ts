import { generateText, type LanguageModel } from "ai";

const MAX_TITLE_LENGTH = 100;

const TITLE_PROMPT = `Generate a concise title for this conversation. Return only the title, with no quotation marks, labels, or explanation. Keep it under 100 characters.`;

export function defaultSessionTitle(now = new Date()): string {
  return `New session - ${now.toISOString()}`;
}

export async function generateSessionTitle(models: LanguageModel[], prompt: string): Promise<string | undefined> {
  for (const model of models) {
    try {
      const { text } = await generateText({ model, system: TITLE_PROMPT, prompt });
      const title = normalizeTitle(text);
      if (title) return title;
    } catch {
      // A title is nonessential: try the next configured fallback quietly.
    }
  }
  return undefined;
}

function normalizeTitle(text: string): string | undefined {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const firstLine = clean.split("\n").map((line) => line.trim()).find(Boolean);
  if (!firstLine) return undefined;
  return firstLine.length <= MAX_TITLE_LENGTH
    ? firstLine
    : `${firstLine.slice(0, MAX_TITLE_LENGTH - 3).trimEnd()}...`;
}
