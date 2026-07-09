import { describe, expect, test } from "bun:test";
import { resolveModelRef } from "../src/model-ref.ts";
import type { ProviderList } from "@cozycode/protocol";

const providers: ProviderList = {
  connected: ["openai", "local"],
  all: [
    {
      id: "openai",
      name: "OpenAI",
      source: "builtin",
      authMethods: [],
      models: [{ id: "gpt-5", name: "GPT-5" }, { id: "shared", name: "Shared" }],
    },
    {
      id: "local",
      name: "Local",
      source: "custom",
      authMethods: [],
      models: [{ id: "llama", name: "Llama" }, { id: "shared", name: "Shared" }],
    },
  ],
};

describe("resolveModelRef", () => {
  test("resolves an explicit provider/model", () => {
    expect(resolveModelRef("openai/gpt-5", providers)).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
  });

  test("resolves a unique bare model id", () => {
    expect(resolveModelRef("llama", providers)).toEqual({
      providerID: "local",
      modelID: "llama",
    });
  });

  test("rejects an ambiguous bare model id", () => {
    expect(resolveModelRef("shared", providers)).toEqual({
      error: "Model id is ambiguous; use provider/model: shared",
    });
  });
});
