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
export { fetchModels, mergeModels } from "./models.ts";
export { buildTools, TOOL_DEFS } from "./tools/index.ts";
export { resolveInWorkspace } from "./tools/paths.ts";
export {
  DEFAULT_SYSTEM_PROMPT,
  PLAN_MODE_REMINDER,
  BUILD_SWITCH_REMINDER,
  PLAN_MODE_DENIAL_MESSAGE,
  DEFAULT_MAX_STEPS,
} from "./config.ts";
export type { ToolDef, ToolContext } from "./tools/types.ts";
/** Re-exported so frontends can type persisted history without depending on `ai`. */
export type { ModelMessage } from "ai";

/** Create a new agent session. Answer `ask` decisions via `session.replyPermission`. */
export function createSession(config: SessionConfig, options?: SessionOptions): Session {
  return new Session(config, options);
}
