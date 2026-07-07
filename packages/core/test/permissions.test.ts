import { test, expect, describe } from "bun:test";
import type { ApprovalOutcome, PermissionPolicy } from "@cozycode/protocol";
import { PermissionGate } from "../src/permissions.ts";

const policy: PermissionPolicy = {
  defaultDecision: "ask",
  tools: { read_file: "allow", run_shell: "ask", secret_tool: "deny" },
};

function input(toolName: string) {
  return { toolCallId: "c1", toolName, args: {}, summary: `run ${toolName}` };
}

describe("PermissionGate", () => {
  test("allow decisions proceed without prompting", async () => {
    let asked = false;
    const gate = new PermissionGate(policy, async () => {
      asked = true;
      return "allow-once";
    });
    const res = await gate.authorize(input("read_file"));
    expect(res).toEqual({ allowed: true, decision: "allow" });
    expect(asked).toBe(false);
  });

  test("deny decisions are blocked without prompting", async () => {
    let asked = false;
    const gate = new PermissionGate(policy, async () => {
      asked = true;
      return "allow-once";
    });
    const res = await gate.authorize(input("secret_tool"));
    expect(res).toEqual({ allowed: false, decision: "deny" });
    expect(asked).toBe(false);
  });

  test("ask defers to the handler; allow-once does not persist", async () => {
    let calls = 0;
    const gate = new PermissionGate(policy, async () => {
      calls += 1;
      return "allow-once";
    });
    expect((await gate.authorize(input("run_shell"))).allowed).toBe(true);
    expect((await gate.authorize(input("run_shell"))).allowed).toBe(true);
    expect(calls).toBe(2); // asked every time
  });

  test("allow-session is remembered for subsequent calls", async () => {
    let calls = 0;
    const outcomes: ApprovalOutcome[] = ["allow-session"];
    const gate = new PermissionGate(policy, async () => {
      calls += 1;
      return outcomes[calls - 1] ?? "deny";
    });
    expect((await gate.authorize(input("run_shell"))).allowed).toBe(true);
    // Second call should NOT ask again — the grant is remembered.
    expect((await gate.authorize(input("run_shell"))).allowed).toBe(true);
    expect(calls).toBe(1);
    expect(gate.resolve("run_shell")).toBe("allow");
  });

  test("deny outcome from handler blocks the call", async () => {
    const gate = new PermissionGate(policy, async () => "deny");
    expect((await gate.authorize(input("run_shell"))).allowed).toBe(false);
  });

  test("unlisted tools fall back to defaultDecision", async () => {
    const gate = new PermissionGate(policy, async () => "allow-once");
    expect(gate.resolve("unknown_tool")).toBe("ask");
  });
});
