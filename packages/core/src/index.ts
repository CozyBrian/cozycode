import type { SessionConfig } from "@cozycode/protocol";
import { Session, type SessionOptions } from "./session.ts";

export { Session, type SessionOptions } from "./session.ts";
export {
  PermissionService,
  PermissionDeniedError,
  PermissionRejectedError,
  PermissionCorrectedError,
  evaluateRule,
  type AskInput,
} from "./permission/service.ts";
export { wildcardMatch } from "./permission/wildcard.ts";
export { QuestionService, QuestionRejectedError, type AskQuestionInput } from "./question/service.ts";
export {
  loadAgents,
  parseAgentMarkdown,
  deriveSubagentRuleset,
  BUILTIN_AGENTS,
  EXPLORE_RULESET,
} from "./agents.ts";
export { prefix } from "./permission/arity.ts";
export { commandPatterns, type BashPermissionInput } from "./permission/bash-patterns.ts";
export {
  rulesetFromConfig,
  mergeRulesets,
  DEFAULT_RULESET,
  FULL_ACCESS_RULESET,
  PLAN_RULESET,
} from "./permission/config.ts";
export { AsyncEventQueue } from "./events.ts";
export { createModel } from "./model.ts";
export { defaultSessionTitle, generateSessionTitle } from "./title.ts";
export { generateModelText } from "./generate.ts";
export { reasoningEfforts, reasoningProviderOptions } from "./reasoning.ts";
export { fetchModels, mergeModels } from "./models.ts";
export { AuthStore, ProviderRegistry, auth, registry } from "./providers.ts";
export {
  ModelsDevCatalog,
  modelsDev,
  type CatalogProvider,
  type ProviderCatalog,
} from "./models-dev.ts";
export { OAuthService, type OAuthFlow } from "./oauth.ts";
import { auth as providerAuth } from "./providers.ts";
import { OAuthService } from "./oauth.ts";
export const oauth = new OAuthService(providerAuth);
export { buildTools, TOOL_DEFS } from "./tools/index.ts";
export { resolveInWorkspace } from "./tools/paths.ts";
export {
  DEFAULT_SYSTEM_PROMPT,
  PLAN_MODE_REMINDER,
  BUILD_SWITCH_REMINDER,
  PLAN_MODE_DENIAL_MESSAGE,
  DEFAULT_MAX_STEPS,
} from "./config.ts";
export type { ToolDef, ToolContext, SpawnSubagentFn } from "./tools/types.ts";
export { askUserTool } from "./tools/ask-user.ts";
/** Re-exported so frontends can type persisted history without depending on `ai`. */
export type { ModelMessage } from "ai";

/** Create a new agent session. Answer `ask` decisions via `session.replyPermission`. */
export function createSession(config: SessionConfig, options?: SessionOptions): Session {
  return new Session(config, options);
}
