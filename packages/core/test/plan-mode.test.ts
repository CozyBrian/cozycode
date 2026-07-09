import { test, expect, describe } from "bun:test";
import type { ApprovalOutcome, PermissionPolicy } from "@cozycode/protocol";
import { PermissionGate } from "../src/permissions.ts";
import { PLAN_MODE_DENIAL_MESSAGE } from "../src/config.ts";

const policy: PermissionPolicy = {
  defaultDecision: "allow",
  tools: { write_file: "allow", edit_file: "allow", run_shell: "allow" },
};

function input(toolName: string, args: unknown = {}) {
  return {
    toolCallId: "c1",
    toolName,
    args,
    summary: `${toolName}`,
  };
}

describe("PermissionGate plan mode", () => {
  test("hard-denies write_file even when policy is allow", async () => {
    const gate = new PermissionGate(policy, async () => "allow-once", "plan");
    const res = await gate.authorize(input("write_file", { path: "a", content: "x" }));
    expect(res).toEqual({
      allowed: false,
      decision: "deny",
      message: PLAN_MODE_DENIAL_MESSAGE,
    });
  });

  test("hard-denies edit_file even when policy is allow", async () => {
    const gate = new PermissionGate(policy, async () => "allow-once", "plan");
    const res = await gate.authorize(input("edit_file", { path: "a" }));
    expect(res).toEqual({
      allowed: false,
      decision: "deny",
      message: PLAN_MODE_DENIAL_MESSAGE,
    });
  });

  test("run_shell follows normal policy in plan mode", async () => {
    let asks = 0;
    const outcomes: ApprovalOutcome[] = ["allow-once"];
    const askPolicy: PermissionPolicy = {
      defaultDecision: "ask",
      tools: { run_shell: "ask" },
      shellDestructiveDecision: "deny",
    };
    const gate = new PermissionGate(askPolicy, async () => {
      asks += 1;
      return outcomes[asks - 1] ?? "deny";
    }, "plan");

    expect(
      await gate.authorize(input("run_shell", { command: "git status" })),
    ).toEqual({ allowed: true, decision: "allow" });
    expect(asks).toBe(0);

    expect(
      await gate.authorize(input("run_shell", { command: "bun run build" })),
    ).toEqual({ allowed: true, decision: "ask" });
    expect(asks).toBe(1);

    expect(
      await gate.authorize(input("run_shell", { command: "rm -rf x" })),
    ).toEqual({ allowed: false, decision: "deny" });
    expect(asks).toBe(1);
  });

  test("read-only tools follow the normal policy in plan mode", async () => {
    const gate = new PermissionGate(policy, async () => "allow-once", "plan");
    expect((await gate.authorize(input("read_file", { path: "a" }))).allowed).toBe(true);
    expect((await gate.authorize(input("search", { glob: "*.ts" }))).allowed).toBe(true);
  });

  test("setMode(plan) clears session grants so prior allows stop applying", async () => {
    const gate = new PermissionGate(policy, async () => "allow-session");
    // Grant write_file in build mode.
    expect((await gate.authorize(input("write_file", { path: "a", content: "x" }))).allowed).toBe(true);
    expect(gate.resolve("write_file")).toBe("allow");

    gate.setMode("plan");
    expect(gate.getMode()).toBe("plan");
    // Grant is gone; plan enforcement denies regardless.
    expect(gate.resolve("write_file")).toBe("allow"); // policy still says allow
    const res = await gate.authorize(input("write_file", { path: "a", content: "x" }));
    expect(res.allowed).toBe(false); // but plan override denies
  });

  test("setMode(build) restores normal authorization", async () => {
    const gate = new PermissionGate(policy, async () => "allow-once", "plan");
    expect((await gate.authorize(input("write_file", { path: "a", content: "x" }))).allowed).toBe(false);
    gate.setMode("build");
    expect((await gate.authorize(input("write_file", { path: "a", content: "x" }))).allowed).toBe(true);
  });
});
