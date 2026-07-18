import { test, expect, describe } from "bun:test";
import type { AgentMode, SessionEvent } from "@cozycode/protocol";
import {
  PermissionService,
  PermissionDeniedError,
  evaluateRule,
} from "../src/permission/service.ts";
import {
  FULL_ACCESS_RULESET,
  rulesetFromConfig,
  mergeRulesets,
  PLAN_RULESET,
} from "../src/permission/config.ts";
import { QuestionService } from "../src/question/service.ts";
import { buildTools, PLAN_MODE_SHELL_DENIAL_MESSAGE } from "../src/tools/index.ts";
import { PLAN_MODE_DENIAL_MESSAGE } from "../src/config.ts";

/** The effective ruleset for a full-access session switched into plan mode. */
function planRuleset() {
  return mergeRulesets(FULL_ACCESS_RULESET, PLAN_RULESET);
}

describe("plan-mode ruleset overlay", () => {
  test("edit is denied even when the base ruleset allows it", async () => {
    const svc = new PermissionService(planRuleset(), "s1", () => {});
    await expect(
      svc.ask({ permission: "edit", patterns: ["a.ts"], always: ["*"], metadata: {} }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("bash is denied even when the base ruleset allows it", async () => {
    const svc = new PermissionService(planRuleset(), "s1", () => {});
    await expect(
      svc.ask({ permission: "bash", patterns: ["git status"], always: ["git status *"], metadata: {} }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  test("unknown and mutating bash are denied over a full-access base", () => {
    expect(evaluateRule("bash", "bun run build", planRuleset()).action).toBe("deny");
    expect(evaluateRule("bash", "rm -rf build", planRuleset()).action).toBe("deny");
  });

  test("compound commands are denied regardless of their segments", async () => {
    const svc = new PermissionService(planRuleset(), "s1", () => {});
    await expect(
      svc.ask({
        permission: "bash",
        patterns: ["git status", "rg TODO"],
        always: ["git status *", "rg *"],
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      svc.ask({
        permission: "bash",
        patterns: ["git status", "rm -rf build"],
        always: ["git status *", "rm *"],
        metadata: {},
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe("buildTools plan-mode boundary", () => {
  function toolsForMode(mode: AgentMode, ruleset = FULL_ACCESS_RULESET) {
    const events: SessionEvent[] = [];
    const svc = new PermissionService(ruleset, "s1", (e) => events.push(e));
    const questions = new QuestionService("s1", (e) => events.push(e));
    const tools = buildTools({
      ctx: { workspaceRoot: "/tmp" },
      permissions: svc,
      questions,
      getMode: () => mode,
      reportToolMetadata: () => {},
    });
    return { tools, events };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const execute = (tools: ReturnType<typeof buildTools>, name: string, args: any) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tools[name] as any).execute(args, { toolCallId: `call-${name}` });

  test("all edit tools are denied with guidance despite full access", async () => {
    const { tools, events } = toolsForMode("plan");
    const attempts = [
      ["write_file", { path: "a.txt", content: "x" }],
      ["edit_file", { path: "a.txt", oldString: "x", newString: "y" }],
      ["apply_patch", { patchText: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch" }],
    ] as const;

    for (const [name, args] of attempts) {
      await expect(execute(tools, name, args)).resolves.toEqual({
        denied: true,
        message: PLAN_MODE_DENIAL_MESSAGE,
      });
    }
    expect(events.some((event) => event.type === "permission-asked")).toBe(false);
  });

  test("all shell commands return plan-mode guidance", async () => {
    const { tools } = toolsForMode("plan");
    for (const command of [
      "pwd",
      "git status",
      "bun run build",
      "node -e 'require(\"fs\").writeFileSync(\"out\", \"x\")'",
      "find . -delete",
      "sort input -o output",
      "git branch new-branch",
      "pwd | rm -rf build",
    ]) {
      await expect(execute(tools, "run_shell", { command })).resolves.toEqual({
        denied: true,
        message: PLAN_MODE_SHELL_DENIAL_MESSAGE,
      });
    }
  });

  test("plan-denied shell never emits a permission prompt", async () => {
    const { tools, events } = toolsForMode("plan", rulesetFromConfig({ bash: "ask" }));
    const result = await execute(tools, "run_shell", { command: "rm -rf build" });

    expect(result).toEqual({ denied: true, message: PLAN_MODE_SHELL_DENIAL_MESSAGE });
    expect(events.some((event) => event.type === "permission-asked")).toBe(false);
  });

  test("switching to plan invalidates a pending build-mode shell approval", async () => {
    let mode: AgentMode = "build";
    const events: SessionEvent[] = [];
    const svc = new PermissionService(rulesetFromConfig({ bash: "ask" }), "s1", (event) =>
      events.push(event),
    );
    const tools = buildTools({
      ctx: { workspaceRoot: "/tmp" },
      permissions: svc,
      questions: new QuestionService("s1", () => {}),
      getMode: () => mode,
      reportToolMetadata: () => {},
    });

    const pending = execute(tools, "run_shell", { command: "printf unsafe-after-switch" });
    const request = events.find((event) => event.type === "permission-asked");
    expect(request?.type).toBe("permission-asked");

    mode = "plan";
    svc.setRuleset(planRuleset());
    if (request?.type === "permission-asked") svc.reply(request.request.id, "once");

    await expect(pending).resolves.toEqual({
      denied: true,
      message: PLAN_MODE_SHELL_DENIAL_MESSAGE,
    });
  });

  test("build mode retains full-access shell behavior", async () => {
    const { tools } = toolsForMode("build");
    const result = await execute(tools, "run_shell", { command: "printf build-mode" });

    expect(result.denied).toBeUndefined();
    expect(result.stdout).toBe("build-mode");
  });
});
