import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { SessionConfig } from "@cozycode/protocol";
import { DEFAULT_PERMISSION_POLICY } from "@cozycode/core";

/** Shape of an optional on-disk config file. */
interface FileConfig {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export interface ResolvedConfig {
  session: SessionConfig;
  /** For display in the status bar. */
  model: string;
  workspaceRoot: string;
  /** Where non-env values came from, for diagnostics. */
  configSource?: string;
}

/**
 * Resolve run configuration from (in order of precedence) environment
 * variables, a `cozycode.json` in the workspace, then `~/.config/cozycode/
 * config.json`. Throws a helpful error when required fields are missing.
 */
export function resolveConfig(argv: string[], env: NodeJS.ProcessEnv): ResolvedConfig {
  const positional = argv.find((a) => !a.startsWith("-"));
  const workspaceRoot = positional ? resolve(positional) : process.cwd();

  const candidates = [
    join(workspaceRoot, "cozycode.json"),
    join(homedir(), ".config", "cozycode", "config.json"),
  ];
  let file: FileConfig = {};
  let configSource: string | undefined;
  for (const path of candidates) {
    const parsed = tryReadJson(path);
    if (parsed) {
      file = parsed;
      configSource = path;
      break;
    }
  }

  const baseURL = env.COZY_BASE_URL ?? file.baseURL;
  const model = env.COZY_MODEL ?? file.model;
  const apiKey = env.COZY_API_KEY ?? file.apiKey;
  const providerName = env.COZY_PROVIDER ?? file.provider ?? "openai-compatible";

  const missing: string[] = [];
  if (!baseURL) missing.push("baseURL (COZY_BASE_URL)");
  if (!model) missing.push("model (COZY_MODEL)");
  if (missing.length > 0) {
    throw new Error(
      `Missing required config: ${missing.join(", ")}.\n` +
        `Set them via environment variables, a cozycode.json in the workspace, ` +
        `or ~/.config/cozycode/config.json.`,
    );
  }

  return {
    session: {
      provider: { name: providerName, baseURL: baseURL!, apiKey },
      model: model!,
      workspaceRoot,
      permissions: DEFAULT_PERMISSION_POLICY,
    },
    model: model!,
    workspaceRoot,
    configSource,
  };
}

function tryReadJson(path: string): FileConfig | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FileConfig;
  } catch {
    return null;
  }
}
