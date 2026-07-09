import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CustomProviderInput,
  ProviderConfig,
  ProviderInfo,
  ProviderList,
} from "@cozycode/protocol";
import { modelsDev, type ProviderCatalog } from "./models-dev.ts";
import { ensureOpenAICredential } from "./oauth.ts";

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/;
const KEYLESS = "__cozycode_keyless__";
const CODEX_MODELS = new Set(["gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini"]);
const CODEX_BLOCKED_MODELS = new Set(["gpt-5.5-pro"]);
const configDir = join(homedir(), ".config", "cozycode");

export interface OAuthCredential {
  access: string;
  refresh: string;
  expires: number;
  accountID?: string;
}

interface AuthFile {
  keys?: Record<string, string>;
  oauth?: Record<string, OAuthCredential>;
}

interface CustomProviderRecord {
  id: string;
  name: string;
  baseURL: string;
  models: string[];
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export class AuthStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly file = join(configDir, "auth.json")) {}

  async getKey(providerID: string): Promise<string | undefined> {
    await this.writeQueue;
    return (await readJson<AuthFile>(this.file, {})).keys?.[providerID];
  }

  setKey(providerID: string, key: string): Promise<void> {
    return this.mutate(async () => {
      const data = await readJson<AuthFile>(this.file, {});
      data.keys = { ...data.keys, [providerID]: key };
      if (data.oauth) delete data.oauth[providerID];
      await writeJson(this.file, data);
    });
  }

  async getOAuth(providerID: string): Promise<OAuthCredential | undefined> {
    await this.writeQueue;
    return (await readJson<AuthFile>(this.file, {})).oauth?.[providerID];
  }

  setOAuth(providerID: string, credential: OAuthCredential): Promise<void> {
    return this.mutate(async () => {
      const data = await readJson<AuthFile>(this.file, {});
      data.oauth = { ...data.oauth, [providerID]: credential };
      if (data.keys) delete data.keys[providerID];
      await writeJson(this.file, data);
    });
  }

  async replaceOAuth(
    providerID: string,
    expected: OAuthCredential,
    credential: OAuthCredential,
  ): Promise<boolean> {
    return this.mutate(async () => {
      const data = await readJson<AuthFile>(this.file, {});
      const current = data.oauth?.[providerID];
      if (!current || current.access !== expected.access || current.refresh !== expected.refresh) return false;
      data.oauth = { ...data.oauth, [providerID]: credential };
      await writeJson(this.file, data);
      return true;
    });
  }

  remove(providerID: string): Promise<void> {
    return this.mutate(async () => {
      const data = await readJson<AuthFile>(this.file, {});
      if (!data.keys?.[providerID] && !data.oauth?.[providerID]) return;
      if (data.keys) delete data.keys[providerID];
      if (data.oauth) delete data.oauth[providerID];
      await writeJson(this.file, data);
    });
  }

  async connected(): Promise<string[]> {
    await this.writeQueue;
    const data = await readJson<AuthFile>(this.file, {});
    return [...new Set([
      ...Object.entries(data.keys ?? {}).filter(([, key]) => Boolean(key)).map(([id]) => id),
      ...Object.keys(data.oauth ?? {}),
    ])];
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(() => {}, () => {});
    return result;
  }
}

export class ProviderRegistry {
  constructor(
    private readonly authStore: AuthStore,
    private readonly catalog: ProviderCatalog = modelsDev,
    private readonly customFile = join(configDir, "providers.json"),
  ) {}

  invalidate(): void {
    // Provider/auth files are read on each call; the catalog owns its TTL.
  }

  private async custom(): Promise<CustomProviderRecord[]> {
    return readJson<CustomProviderRecord[]>(this.customFile, []);
  }

  async list(): Promise<ProviderList> {
    const custom = await this.custom();
    const catalog = await this.catalog.get();
    const connected = new Set(await this.authStore.connected());
    const openAIOAuth = Boolean(await this.authStore.getOAuth("openai"));
    const supportedCatalog = catalog.filter((provider) =>
      provider.id === "openai" || provider.npm === "@ai-sdk/openai-compatible",
    );
    const byID = new Map<string, ProviderInfo>(supportedCatalog.map((provider) => [provider.id, {
      id: provider.id,
      name: provider.name,
      source: "builtin",
      authMethods: provider.id === "openai"
        ? [
            { type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
            { type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
            { type: "api", label: "API key" },
          ]
        : [{ type: "api", label: "API key" }],
      models: provider.id === "openai" && openAIOAuth
        ? provider.models.filter((model) => supportsCodexOAuth(model.id)).map((model) => ({
            ...model,
            cost: model.cost ? { input: 0, output: 0 } : undefined,
          }))
        : provider.models,
    }]));
    for (const provider of custom) {
      const existing = byID.get(provider.id);
      byID.set(provider.id, {
        id: provider.id,
        name: provider.name || existing?.name || provider.id,
        source: "custom",
        authMethods: existing?.authMethods ?? [{ type: "api", label: "API key" }],
        models: provider.models.length
          ? provider.models.map((id) => ({ id, name: id }))
          : existing?.models ?? [],
      });
    }
    const all = [...byID.values()];
    const connectedIDs = [...connected].filter((id) => all.some((provider) => provider.id === id));
    const first = all.find((provider) => connected.has(provider.id) && provider.models[0]);
    return {
      all,
      connected: connectedIDs,
      defaultModel: first?.models[0]
        ? { providerID: first.id, modelID: first.models[0].id }
        : undefined,
    };
  }

  async addCustom(input: CustomProviderInput): Promise<void> {
    if (!PROVIDER_ID.test(input.id)) throw new Error("Invalid provider id.");
    let url: URL;
    try {
      url = new URL(input.baseURL);
    } catch {
      throw new Error("Base URL must be a valid URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Base URL must use http or https.");
    }
    const custom = await this.custom();
    const configuredModels = [...new Set((input.models ?? []).map((id) => id.trim()).filter(Boolean))];
    const record: CustomProviderRecord = {
      id: input.id,
      name: input.name?.trim() || input.id,
      baseURL: input.baseURL.replace(/\/$/, ""),
      models: configuredModels.length
        ? configuredModels
        : await discoverModels(input.baseURL, input.apiKey),
    };
    const index = custom.findIndex((provider) => provider.id === input.id);
    if (index >= 0) custom[index] = record;
    else custom.push(record);
    await writeJson(this.customFile, custom);
    await this.authStore.setKey(input.id, input.apiKey || KEYLESS);
  }

  async connect(providerID: string, key?: string): Promise<void> {
    await this.providerConfig(providerID);
    await this.authStore.setKey(providerID, key || KEYLESS);
  }

  async providerConfig(providerID: string): Promise<ProviderConfig> {
    if (providerID === "openai") {
      const oauth = await this.authStore.getOAuth(providerID);
      if (oauth) {
        const credential = await ensureOpenAICredential(this.authStore);
        return {
          name: "openai-oauth",
          kind: "openai-oauth",
          baseURL: "https://chatgpt.com/backend-api/codex",
          apiKey: credential.access,
          headers: {
            ...(credential.accountID ? { "ChatGPT-Account-Id": credential.accountID } : {}),
            originator: "cozycode",
          },
        };
      }
      return {
        name: "openai",
        kind: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: await this.authStore.getKey(providerID),
      };
    }
    const provider = (await this.custom()).find((item) => item.id === providerID);
    const catalog = (await this.catalog.get()).find((item) => item.id === providerID);
    if (!provider && !catalog) throw new Error(`Unknown provider: ${providerID}`);
    return {
      name: providerID,
      baseURL: provider?.baseURL || catalog?.api || "",
      apiKey: (await this.authStore.getKey(providerID)) === KEYLESS
        ? undefined
        : await this.authStore.getKey(providerID),
    };
  }
}

export const auth = new AuthStore();
export const registry = new ProviderRegistry(auth);

function supportsCodexOAuth(modelID: string): boolean {
  if (CODEX_MODELS.has(modelID)) return true;
  if (CODEX_BLOCKED_MODELS.has(modelID)) return false;
  const version = /^gpt-(\d+\.\d+)/.exec(modelID)?.[1];
  return version ? Number.parseFloat(version) > 5.4 : false;
}

async function discoverModels(baseURL: string, key?: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
      headers: key && key !== KEYLESS ? { Authorization: `Bearer ${key}` } : undefined,
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return [];
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string")
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}
