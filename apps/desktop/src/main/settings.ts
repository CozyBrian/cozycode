import { app, safeStorage } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthStore, ProviderRegistry } from "@cozycode/core";
import type { AppSettings, AppSettingsInput } from "../shared/ipc.ts";

interface StoredSettings extends Partial<AppSettings> {
  providerName?: string;
  baseURL?: string;
  model?: string;
  apiKeyEnc?: string;
  apiKeyPlain?: string;
}

export class SettingsStore {
  private readonly file = join(app.getPath("userData"), "cozycode-settings.json");
  private cache: AppSettings | null | undefined;
  legacyProviderID = "openai";

  private async readStored(): Promise<StoredSettings | null> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as StoredSettings;
    } catch {
      return null;
    }
  }

  async getPublic(): Promise<AppSettings | null> {
    if (this.cache !== undefined) return this.cache;
    const stored = await this.readStored();
    if (!stored?.workspaceRoot) return (this.cache = null);
    return (this.cache = {
      workspaceRoot: stored.workspaceRoot,
      permissions: stored.permissions,
      recentModels: stored.recentModels,
      reasoningEfforts: stored.reasoningEfforts,
      showContextSize: stored.showContextSize,
    });
  }

  async save(input: AppSettingsInput): Promise<AppSettings> {
    const next: AppSettings = {
      workspaceRoot: input.workspaceRoot,
      permissions: input.permissions,
      recentModels: input.recentModels?.slice(0, 8),
      reasoningEfforts: input.reasoningEfforts,
      showContextSize: input.showContextSize,
    };
    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(this.file, JSON.stringify(next, null, 2), "utf8");
    this.cache = next;
    return next;
  }

  async migrateProviderCredentials(registry: ProviderRegistry, auth: AuthStore): Promise<void> {
    const stored = await this.readStored();
    if (!stored?.baseURL) return;
    let key = stored.apiKeyPlain;
    if (stored.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      try {
        key = safeStorage.decryptString(Buffer.from(stored.apiKeyEnc, "base64"));
      } catch {
        return;
      }
    }

    if (stored.baseURL.startsWith("https://api.openai.com")) {
      this.legacyProviderID = "openai";
      if (key) await auth.setKey("openai", key);
    } else {
      const id = slug(stored.providerName || "custom");
      this.legacyProviderID = id;
      await registry.addCustom({
        id,
        name: stored.providerName,
        baseURL: stored.baseURL,
        apiKey: key,
        models: stored.model ? [stored.model] : undefined,
      });
    }
    await this.save({
      workspaceRoot: stored.workspaceRoot || app.getPath("home"),
      permissions: stored.permissions,
      recentModels: stored.model
        ? [{ providerID: this.legacyProviderID, modelID: stored.model }]
        : stored.recentModels,
    });
  }
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return result || "custom";
}
