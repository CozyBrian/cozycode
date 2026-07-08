import { test, expect, describe } from "bun:test";
import type { PermissionPolicy } from "@cozycode/protocol";
import { PermissionGate } from "../src/permissions.ts";

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
    expect(res).toEqual({ allowed: false, decision: "deny" });
  });

  test("hard-denies edit_file even when policy is allow", async () => {
    const gate = new PermissionGate(policy, async () => "allow-once", "plan");
    const res = await gate.authorize(input("edit_file", { path: "a" }));
    expect(res).toEqual({ allowed: false, decision: "deny" });
  });

  test("allows safe shell commands but denies destructive ones", async () => {
    const gate = new PermissionGate(policy, async () => "allow-once", "plan");
    expect((await gate.authorize(input("run_shell", { command: "git status" }))).allowed).toBe(true);
    expect((await gate.authorize(input("run_shell", { command: "rm -rf x" }))).allowed).toBe(false);
  });

  test("denies unknown shell commands without prompting", async () => {
    let asked = false;
    const gate = new PermissionGate(policy, async () => {
      asked = true;
      return "allow-once";
    }, "plan");
    const res = await gate.authorize(input("run_shell", { command: "bun run build" }));
    expect(res).toEqual({ allowed: false, decision: "deny" });
    expect(asked).toBe(false);
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

  test("allows write_file and edit_file targeting the plan file in plan mode", async () => {
    const gate = new PermissionGate(policy, async () => "allow-once", "plan");
    const planPath = ".cozycode/plans/session-1.md";
    gate.setPlanFile(planPath);

    expect(
      (await gate.authorize(input("write_file", { path: planPath, content: "plan" })))
        .allowed,
    ).toBe(true);
    expect(
      (await gate.authorize(input("edit_file", { path: planPath }))).allowed,
    ).toBe(true);
    // Other paths still denied.
    expect(
      (await gate.authorize(input("write_file", { path: "src/main.ts", content: "x" })))
        .allowed,
    ).toBe(false);
  });

  test("setPlanFile(null) removes the exemption", async () => {
    const gate = new PermissionGate(policy, async () => "allow-once", "plan");
    const planPath = ".cozycode/plans/session-1.md";
    gate.setPlanFile(planPath);
    expect(
      (await gate.authorize(input("write_file", { path: planPath, content: "plan" })))
        .allowed,
    ).toBe(true);
    gate.setPlanFile(null);
    expect(
      (await gate.authorize(input("write_file", { path: planPath, content: "plan" })))
        .allowed,
    ).toBe(false);
  });});