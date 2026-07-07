import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import type { ProviderConfig } from "@cozycode/protocol";

/**
 * Build an AI SDK language model from a provider config. Everything flows
 * through the OpenAI-compatible provider, so any endpoint that speaks that
 * dialect (OpenAI, OpenRouter, a local llama.cpp/Ollama server, ...) works
 * with only a `baseURL`/`apiKey`/`model` change — the harness stays
 * provider-agnostic.
 */
export function createModel(provider: ProviderConfig, model: string): LanguageModel {
  const openaiCompatible = createOpenAICompatible({
    name: provider.name,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey ?? "",
    headers: provider.headers,
  });
  return openaiCompatible(model);
}
