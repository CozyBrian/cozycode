import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { ProviderConfig } from "@cozycode/protocol";
import { auth } from "./providers.ts";
import { ensureOpenAICredential } from "./oauth.ts";

/**
 * Build an AI SDK language model from a provider config. Everything flows
 * through the OpenAI-compatible provider, so any endpoint that speaks that
 * dialect (OpenAI, OpenRouter, a local llama.cpp/Ollama server, ...) works
 * with only a `baseURL`/`apiKey`/`model` change — the harness stays
 * provider-agnostic.
 */
export function createModel(provider: ProviderConfig, model: string): LanguageModel {
  if (provider.kind === "openai" || provider.kind === "openai-oauth") {
    const openai = createOpenAI({
      baseURL: provider.baseURL,
      apiKey: provider.apiKey ?? "",
      headers: provider.headers,
      fetch: provider.kind === "openai-oauth" ? oauthFetch as typeof fetch : undefined,
    });
    return openai.responses(model);
  }
  const openaiCompatible = createOpenAICompatible({
    name: provider.name,
    baseURL: provider.baseURL,
    apiKey: provider.apiKey ?? "",
    headers: provider.headers,
  });
  return openaiCompatible(model);
}

async function oauthFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const credential = await ensureOpenAICredential(auth);
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${credential.access}`);
  headers.set("originator", "cozycode");
  if (credential.accountID) headers.set("ChatGPT-Account-Id", credential.accountID);
  return fetch(input, { ...init, headers });
}
