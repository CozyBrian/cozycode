import { test, expect, describe } from "bun:test";
import type { AgentMode, SessionEvent } from "@cozycode/protocol";
import { PermissionService, PermissionDeniedError } from "../src/permission/service.ts";
import { rulesetFromConfig, mergeRulesets, PLAN_RULESET } from "../src/permission/config.ts";
import { buildTools } from "../src/tools/index.ts";
import { PLAN_MODE_DENIAL_MESSAGE } from "../src/config.ts";

/** The effective ruleset for plan mode: base (allow-all here) + plan overlay. */
function planRuleset() {
  return mergeRulesets(rulesetFromConfig("allow"), PLAN_RULESET);
}

describe("plan-mode ruleset overlay", () => {
  test("edit is denied even when the base ruleset allows it", async () => {
    const svc = new PermissionService(planRuleset(), "s1", () => {});
    await expect(
      svc.ask({ permission: "edit", patterns: ["a.ts"], always: ["*"], metadata: {} }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("bash is still allowed by the base (not touched by the plan overlay)", async () => {
    const svc = new PermissionService(planRuleset(), "s1", () => {});
    // base is allow-all, so a bash command resolves silently under plan too.
    await expect(
      svc.ask({ permission: "bash", patterns: ["ls"], always: ["ls *"], metadata: {} }),
    ).resolves.toBeUndefined();
  });
});

describe("buildTools plan-mode denial message", () => {
  function toolsForMode(mode: AgentMode) {
    const events: SessionEvent[] = [];
    const svc = new PermissionService(planRuleset(), "s1", (e) => events.push(e));
    const tools = buildTools({
      ctx: { workspaceRoot: "/tmp" },
      permissions: svc,
      getMode: () => mode,
    });
    return tools;
  }

  test("a denied edit in plan mode returns the plan-mode guidance", async () => {
    const tools = toolsForMode("plan");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const execute = (tools.write_file as any).execute;
    const result = await execute(
      { path: "a.txt", content: "x" },
      { toolCallId: "c1" },
    );
    expect(result).toEqual({ denied: true, message: PLAN_MODE_DENIAL_MESSAGE });
  });
});
