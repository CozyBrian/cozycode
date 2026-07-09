import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import type { ModelRef, PermissionConfig, SessionConfig } from "@cozycode/protocol";
import { DEFAULT_RULESET, mergeRulesets, rulesetFromConfig } from "@cozycode/core";

/** Shape of an optional on-disk config file. */
interface FileConfig {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
  /** Optional explicit list of selectable models. */
  models?: string[];
  /** Optional permission-rule overrides, merged over the default ruleset. */
  permissions?: PermissionConfig;
}

export interface ResolvedConfig {
  /** Legacy env/file override. Registry-backed sessions are built in the app. */
  session: SessionConfig | null;
  initialModel: ModelRef | null;
  workspaceRoot: string;
  /** Where non-env values came from, for diagnostics. */
  configSource?: string;
}

/**
 * Resolve run configuration from (in order of precedence) environment
 * variables, a `cozycode.json` in the workspace, then `~/.config/cozycode/
 * config.json`. An incomplete configuration is valid: the TUI will open
 * provider onboarding and create a session after a model is available.
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
  const providerName = env.COZY_PROVIDER ?? file.provider ?? (baseURL ? "openai-compatible" : undefined);
  const initialModel = providerName && model ? { providerID: providerName, modelID: model } : null;
  const permissions = file.permissions
    ? mergeRulesets(DEFAULT_RULESET, rulesetFromConfig(file.permissions))
    : DEFAULT_RULESET;
  const session = baseURL && model
    ? {
        provider: { name: providerName ?? "openai-compatible", baseURL, apiKey },
        model,
        models: Array.isArray(file.models) ? file.models : undefined,
        workspaceRoot,
        permissions,
      }
    : null;

  return {
    session,
    initialModel,
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
