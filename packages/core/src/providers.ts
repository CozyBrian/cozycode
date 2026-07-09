import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CustomProviderInput,
  ModelInfo,
  ProviderConfig,
  ProviderInfo,
  ProviderList,
} from "@cozycode/protocol";

const PROVIDER_ID = /^[a-z0-9][a-z0-9-_]*$/;
const KEYLESS = "__cozycode_keyless__";
const configDir = join(homedir(), ".config", "cozycode");

interface AuthFile {
  keys?: Record<string, string>;
}

interface CustomProviderRecord {
  id: string;
  name: string;
  baseURL: string;
  models: string[];
}

const OPENAI_MODELS: ModelInfo[] = [
  { id: "gpt-5.2", name: "GPT-5.2", contextWindow: 400_000 },
  { id: "gpt-5.1", name: "GPT-5.1", contextWindow: 400_000 },
  { id: "gpt-5", name: "GPT-5", contextWindow: 400_000 },
  { id: "gpt-4.1", name: "GPT-4.1", contextWindow: 1_047_576 },
  { id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
  { id: "o3", name: "o3", contextWindow: 200_000 },
  { id: "o4-mini", name: "o4-mini", contextWindow: 200_000 },
];

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

export class AuthStore {
  readonly file = join(configDir, "auth.json");

  async getKey(providerID: string): Promise<string | undefined> {
    return (await readJson<AuthFile>(this.file, {})).keys?.[providerID];
  }

  async setKey(providerID: string, key: string): Promise<void> {
    const data = await readJson<AuthFile>(this.file, {});
    data.keys = { ...data.keys, [providerID]: key };
    await writeJson(this.file, data);
  }

  async remove(providerID: string): Promise<void> {
    const data = await readJson<AuthFile>(this.file, {});
    if (!data.keys?.[providerID]) return;
    delete data.keys[providerID];
    await writeJson(this.file, data);
  }

  async connected(): Promise<string[]> {
    const data = await readJson<AuthFile>(this.file, {});
    return Object.entries(data.keys ?? {})
      .filter(([, key]) => Boolean(key))
      .map(([id]) => id);
  }
}

export class ProviderRegistry {
  private readonly customFile = join(configDir, "providers.json");

  constructor(private readonly authStore: AuthStore) {}

  invalidate(): void {
    // Reads are intentionally uncached so changes from another process appear.
  }

  private async custom(): Promise<CustomProviderRecord[]> {
    return readJson<CustomProviderRecord[]>(this.customFile, []);
  }

  async list(): Promise<ProviderList> {
    const custom = await this.custom();
    const connected = new Set(await this.authStore.connected());
    const customProviders: ProviderInfo[] = custom.map((provider) => ({
        id: provider.id,
        name: provider.name,
        source: "custom" as const,
        authMethods: [{ type: "api" as const, label: "API key" }],
        models: provider.models.map((id) => ({ id, name: id })),
      }));
    const all: ProviderInfo[] = [
      {
        id: "openai",
        name: "OpenAI",
        source: "builtin",
        authMethods: [{ type: "api", label: "API key" }],
        models: OPENAI_MODELS,
      },
      ...customProviders,
    ];
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
      return {
        name: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKey: await this.authStore.getKey(providerID),
      };
    }
    const provider = (await this.custom()).find((item) => item.id === providerID);
    if (!provider) throw new Error(`Unknown provider: ${providerID}`);
    return {
      name: provider.id,
      baseURL: provider.baseURL,
      apiKey: (await this.authStore.getKey(providerID)) === KEYLESS
        ? undefined
        : await this.authStore.getKey(providerID),
    };
  }
}

export const auth = new AuthStore();
export const registry = new ProviderRegistry(auth);

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
