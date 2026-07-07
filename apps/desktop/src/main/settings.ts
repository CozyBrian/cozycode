import { app, safeStorage } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings, AppSettingsInput } from "../shared/ipc.ts";

interface StoredSettings {
  providerName: string;
  baseURL: string;
  model: string;
  workspaceRoot: string;
  permissions?: AppSettings["permissions"];
  /** Base64 of the encrypted (or plaintext fallback) API key. */
  apiKeyEnc?: string;
  apiKeyPlain?: string;
}

/**
 * Settings persistence. The API key is encrypted with the OS keychain via
 * Electron's safeStorage when available, and never handed back to the renderer
 * (only a `hasApiKey` flag is exposed).
 */
export class SettingsStore {
  private readonly file = join(app.getPath("userData"), "cozycode-settings.json");
  private cache: StoredSettings | null = null;

  private async load(): Promise<StoredSettings | null> {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(await readFile(this.file, "utf8")) as StoredSettings;
      return this.cache;
    } catch {
      return null;
    }
  }

  async getPublic(): Promise<AppSettings | null> {
    const s = await this.load();
    if (!s) return null;
    return {
      providerName: s.providerName,
      baseURL: s.baseURL,
      model: s.model,
      workspaceRoot: s.workspaceRoot,
      permissions: s.permissions,
      hasApiKey: Boolean(s.apiKeyEnc || s.apiKeyPlain),
    };
  }

  /** The decrypted API key for use by the core (main process only). */
  async getApiKey(): Promise<string | undefined> {
    const s = await this.load();
    if (!s) return undefined;
    if (s.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, "base64"));
    }
    return s.apiKeyPlain;
  }

  async save(input: AppSettingsInput): Promise<AppSettings> {
    const prev = await this.load();
    const next: StoredSettings = {
      providerName: input.providerName,
      baseURL: input.baseURL,
      model: input.model,
      workspaceRoot: input.workspaceRoot,
      permissions: input.permissions,
      apiKeyEnc: prev?.apiKeyEnc,
      apiKeyPlain: prev?.apiKeyPlain,
    };

    // A provided key replaces the stored one; an empty string clears it.
    if (input.apiKey !== undefined) {
      delete next.apiKeyEnc;
      delete next.apiKeyPlain;
      if (input.apiKey !== "") {
        if (safeStorage.isEncryptionAvailable()) {
          next.apiKeyEnc = safeStorage.encryptString(input.apiKey).toString("base64");
        } else {
          next.apiKeyPlain = input.apiKey;
        }
      }
    }

    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(this.file, JSON.stringify(next, null, 2), "utf8");
    this.cache = next;
    return (await this.getPublic())!;
  }
}
