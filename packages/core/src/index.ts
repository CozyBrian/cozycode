import type { ApprovalHandler, SessionConfig } from "@cozycode/protocol";
import { Session, type SessionOptions } from "./session.ts";

export { Session, type SessionOptions } from "./session.ts";
export { PermissionGate } from "./permissions.ts";
export { AsyncEventQueue } from "./events.ts";
export { createModel } from "./model.ts";
export { buildTools, TOOL_DEFS } from "./tools/index.ts";
export { resolveInWorkspace } from "./tools/paths.ts";
export {
  DEFAULT_PERMISSION_POLICY,
  DEFAULT_SYSTEM_PROMPT,
  PLAN_MODE_REMINDER,
  BUILD_SWITCH_REMINDER,
  PLAN_MODE_DENIAL_MESSAGE,
  DEFAULT_MAX_STEPS,
} from "./config.ts";
export { MUTATING_TOOLS } from "./tools/index.ts";
export type { ToolDef, ToolContext } from "./tools/types.ts";

/** Create a new agent session. `approvalHandler` answers `ask` decisions. */
export function createSession(
  config: SessionConfig,
  approvalHandler: ApprovalHandler,
  options?: SessionOptions,
): Session {
  return new Session(config, approvalHandler, options);
}
