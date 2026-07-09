import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, ProviderRegistry } from "../src/providers.ts";
import type { ProviderCatalog } from "../src/models-dev.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ProviderRegistry", () => {
  test("an empty custom override inherits models.dev models", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cozy-providers-"));
    dirs.push(dir);
    const auth = new AuthStore(join(dir, "auth.json"));
    await auth.setKey("deepseek", "secret");
    const customFile = join(dir, "providers.json");
    await writeFile(customFile, JSON.stringify([{
      id: "deepseek",
      name: "Deepseek",
      baseURL: "https://api.deepseek.com/v1",
      models: [],
    }]));
    const catalog: ProviderCatalog = {
      invalidate() {},
      async get() {
        return [{
          id: "deepseek",
          name: "DeepSeek",
          api: "https://api.deepseek.com",
          npm: "@ai-sdk/openai-compatible",
          models: [
            { id: "deepseek-chat", name: "DeepSeek Chat" },
            { id: "deepseek-reasoner", name: "DeepSeek Reasoner" },
          ],
        }];
      },
    };
    const registry = new ProviderRegistry(auth, catalog, customFile);

    const list = await registry.list();
    expect(list.connected).toContain("deepseek");
    expect(list.all.find((provider) => provider.id === "deepseek")?.models.map((model) => model.id))
      .toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  test("OAuth-backed OpenAI exposes Codex models and transport", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cozy-providers-"));
    dirs.push(dir);
    const auth = new AuthStore(join(dir, "auth.json"));
    await auth.setOAuth("openai", {
      access: "access",
      refresh: "refresh",
      expires: Date.now() + 60 * 60 * 1000,
      accountID: "acct_test",
    });
    const catalog: ProviderCatalog = {
      invalidate() {},
      async get() {
        return [{
          id: "openai",
          name: "OpenAI",
          api: "https://api.openai.com/v1",
          npm: "@ai-sdk/openai",
          models: [
            { id: "gpt-5.4", name: "GPT-5.4" },
            { id: "gpt-4o", name: "GPT-4o" },
          ],
        }];
      },
    };
    const registry = new ProviderRegistry(auth, catalog, join(dir, "providers.json"));

    expect((await registry.list()).all[0]?.models.map((model) => model.id)).toEqual(["gpt-5.4"]);
    expect(await registry.providerConfig("openai")).toMatchObject({
      kind: "openai-oauth",
      baseURL: "https://chatgpt.com/backend-api/codex",
      headers: { "ChatGPT-Account-Id": "acct_test", originator: "cozycode" },
    });
  });
});
