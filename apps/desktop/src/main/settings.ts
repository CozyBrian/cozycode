import { app, safeStorage } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
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

interface FileConfig {
  provider?: string;
  providerName?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  workspaceRoot?: string;
}

/**
 * Settings persistence. The API key is encrypted with the OS keychain via
 * Electron's safeStorage when available, and never handed back to the renderer
 * (only a `hasApiKey` flag is exposed).
 */
export class SettingsStore {
  private readonly file = join(app.getPath("userData"), "cozycode-settings.json");
  private cache: StoredSettings | null = null;
  private cacheFromFileConfig = false;

  private async load(): Promise<StoredSettings | null> {
    if (this.cache) return this.cache;
    try {
      const stored = JSON.parse(await readFile(this.file, "utf8")) as StoredSettings;
      if (isConfigured(stored)) {
        this.cache = normalize(stored);
        this.cacheFromFileConfig = false;
        return this.cache;
      }
    } catch {
      // Fall through to shared JSON config resolution.
    }
    this.cache = await this.loadFileConfig();
    this.cacheFromFileConfig = Boolean(this.cache);
    return this.cache;
  }

  private async loadFileConfig(): Promise<StoredSettings | null> {
    const candidates = unique([
      ...walkUp(process.cwd()).map((dir) => join(dir, "cozycode.json")),
      ...walkUp(app.getAppPath()).map((dir) => join(dir, "cozycode.json")),
      join(homedir(), ".config", "cozycode", "config.json"),
    ]);

    for (const path of candidates) {
      const parsed = await tryReadJson(path);
      if (!parsed?.baseURL || !parsed.model) continue;
      return {
        providerName: parsed.providerName ?? parsed.provider ?? "openai-compatible",
        baseURL: parsed.baseURL,
        model: parsed.model,
        workspaceRoot: parsed.workspaceRoot ?? workspaceRootFor(path),
        apiKeyPlain: parsed.apiKey,
      };
    }
    return null;
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
    return s.apiKeyPlain ?? (await this.loadFileConfig())?.apiKeyPlain;
  }

  async save(input: AppSettingsInput): Promise<AppSettings> {
    const prev = await this.load();
    const next: StoredSettings = {
      providerName: input.providerName,
      baseURL: input.baseURL,
      model: input.model,
      workspaceRoot: input.workspaceRoot,
      permissions: input.permissions,
      apiKeyEnc: this.cacheFromFileConfig ? undefined : prev?.apiKeyEnc,
      apiKeyPlain: this.cacheFromFileConfig ? undefined : prev?.apiKeyPlain,
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
    this.cacheFromFileConfig = false;
    return (await this.getPublic())!;
  }
}

function normalize(s: StoredSettings): StoredSettings {
  return { ...s, providerName: s.providerName || "openai-compatible" };
}

function isConfigured(s: StoredSettings): boolean {
  return Boolean(s.baseURL && s.model && s.workspaceRoot);
}

function workspaceRootFor(configPath: string): string {
  return configPath === join(homedir(), ".config", "cozycode", "config.json")
    ? homedir()
    : dirname(configPath);
}

function walkUp(start: string): string[] {
  const dirs: string[] = [];
  let current = resolve(start);
  const root = parse(current).root;
  while (true) {
    dirs.push(current);
    if (current === root) return dirs;
    current = dirname(current);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function tryReadJson(path: string): Promise<FileConfig | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as FileConfig;
  } catch {
    return null;
  }
}
