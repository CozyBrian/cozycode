import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelInfo } from "@cozycode/protocol";

const SOURCE = "https://models.dev/api.json";
const MAX_AGE = 5 * 60 * 1000;
const CACHE_VERSION = 2;

export interface CatalogProvider {
  id: string;
  name: string;
  api?: string;
  npm?: string;
  models: ModelInfo[];
}

export interface ProviderCatalog {
  get(): Promise<CatalogProvider[]>;
  invalidate(): void;
}

interface ModelsDevModel {
  id?: string;
  name?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}

interface ModelsDevProvider {
  id?: string;
  name?: string;
  api?: string;
  npm?: string;
  models?: Record<string, ModelsDevModel>;
}

const FALLBACK: CatalogProvider[] = [
  {
    id: "openai",
    name: "OpenAI",
    api: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
    models: [
      { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 1_050_000 },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 400_000 },
      { id: "gpt-5.3-codex-spark", name: "GPT-5.3 Codex Spark", contextWindow: 400_000 },
      { id: "gpt-5.2", name: "GPT-5.2", contextWindow: 400_000 },
      { id: "gpt-5.1", name: "GPT-5.1", contextWindow: 400_000 },
      { id: "gpt-5", name: "GPT-5", contextWindow: 400_000 },
      { id: "gpt-4.1", name: "GPT-4.1", contextWindow: 1_047_576 },
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000 },
      { id: "o3", name: "o3", contextWindow: 200_000 },
      { id: "o4-mini", name: "o4-mini", contextWindow: 200_000 },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    api: "https://api.deepseek.com",
    npm: "@ai-sdk/openai-compatible",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128_000 },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 128_000 },
    ],
  },
];

export class ModelsDevCatalog {
  private readonly file: string;
  private memory: CatalogProvider[] | null = null;

  constructor(file = join(homedir(), ".cache", "cozycode", "models.json")) {
    this.file = file;
  }

  async get(): Promise<CatalogProvider[]> {
    if (this.memory) return this.memory;
    const cached = await this.readCache();
    if (cached) {
      this.memory = cached.providers;
      if (Date.now() - cached.updatedAt > MAX_AGE) void this.refresh().catch(() => {});
      return this.memory;
    }
    return this.refresh().catch(() => (this.memory = FALLBACK));
  }

  async refresh(): Promise<CatalogProvider[]> {
    const response = await fetch(SOURCE, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`models.dev returned ${response.status}.`);
    const providers = normalize(await response.json() as Record<string, ModelsDevProvider>);
    this.memory = providers;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ version: CACHE_VERSION, updatedAt: Date.now(), providers }), "utf8");
    return providers;
  }

  invalidate(): void {
    this.memory = null;
  }

  private async readCache(): Promise<{ updatedAt: number; providers: CatalogProvider[] } | null> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as {
        version?: number;
        updatedAt?: number;
        providers?: CatalogProvider[];
      };
      return parsed.version === CACHE_VERSION
        && typeof parsed.updatedAt === "number"
        && Array.isArray(parsed.providers)
        ? { updatedAt: parsed.updatedAt, providers: parsed.providers }
        : null;
    } catch {
      return null;
    }
  }
}

function normalize(input: Record<string, ModelsDevProvider>): CatalogProvider[] {
  return Object.entries(input).map(([providerID, provider]) => ({
    id: provider.id || providerID,
    name: provider.name || providerID,
    api: provider.api,
    npm: provider.npm,
    models: Object.entries(provider.models ?? {}).map(([modelID, model]) => ({
      id: model.id || modelID,
      name: model.name || modelID,
      contextWindow: model.limit?.context,
      maxOutput: model.limit?.output,
      cost: model.cost?.input !== undefined && model.cost.output !== undefined
        ? { input: model.cost.input, output: model.cost.output }
        : undefined,
    })),
  }));
}

export const modelsDev = new ModelsDevCatalog();
