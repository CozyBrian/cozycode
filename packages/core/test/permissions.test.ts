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
    const runShell = (cmd: string) => ({
      toolCallId: "c1",
      toolName: "run_shell" as const,
      args: { command: cmd },
      summary: `Run: ${cmd}`,
    });
    expect((await gate.authorize(runShell("bun run build"))).allowed).toBe(true);
    expect((await gate.authorize(runShell("bun run build"))).allowed).toBe(true);
    expect(calls).toBe(2); // asked every time
  });

  test("allow-session is remembered for subsequent calls", async () => {
    let calls = 0;
    const outcomes: ApprovalOutcome[] = ["allow-session"];
    const gate = new PermissionGate(policy, async () => {
      calls += 1;
      return outcomes[calls - 1] ?? "deny";
    });
    const runShell = (cmd: string) => ({
      toolCallId: "c1",
      toolName: "run_shell" as const,
      args: { command: cmd },
      summary: `Run: ${cmd}`,
    });
    expect((await gate.authorize(runShell("bun run build"))).allowed).toBe(true);
    // Second call should NOT ask again — the grant is remembered.
    expect((await gate.authorize(runShell("bun run build"))).allowed).toBe(true);
    expect(calls).toBe(1);
    expect(gate.resolve("run_shell")).toBe("allow");
  });

  test("deny outcome from handler blocks the call", async () => {
    const gate = new PermissionGate(policy, async () => "deny");
    expect((await gate.authorize({
      toolCallId: "c1",
      toolName: "run_shell",
      args: { command: "bun run build" },
      summary: "Run: bun run build",
    })).allowed).toBe(false);
  });

  test("unlisted tools fall back to defaultDecision", async () => {
    const gate = new PermissionGate(policy, async () => "allow-once");
    expect(gate.resolve("unknown_tool")).toBe("ask");
  });

  test("safe shell commands bypass approval when policy is ask", async () => {
    let asked = false;
    const gate = new PermissionGate(policy, async () => {
      asked = true;
      return "allow-once";
    });
    const res = await gate.authorize({
      toolCallId: "c1",
      toolName: "run_shell",
      args: { command: "git status" },
      summary: "Run: git status",
    });
    expect(res).toEqual({ allowed: true, decision: "allow" });
    expect(asked).toBe(false);
  });

  test("unknown shell commands prompt when policy is ask", async () => {
    let asked = false;
    const gate = new PermissionGate(policy, async () => {
      asked = true;
      return "allow-once";
    });
    const res = await gate.authorize({
      toolCallId: "c1",
      toolName: "run_shell",
      args: { command: "bun run build" },
      summary: "Run: bun run build",
    });
    expect(res.allowed).toBe(true);
    expect(res.decision).toBe("ask");
    expect(asked).toBe(true);
  });

  test("destructive shell commands prompt when shellDestructiveDecision is ask (default)", async () => {
    let asked = false;
    const gate = new PermissionGate(policy, async () => {
      asked = true;
      return "allow-once";
    });
    const res = await gate.authorize({
      toolCallId: "c1",
      toolName: "run_shell",
      args: { command: "rm -rf node_modules" },
      summary: "Run: rm -rf node_modules",
    });
    expect(res.allowed).toBe(true);
    expect(res.decision).toBe("ask");
    expect(asked).toBe(true);
  });

  test("destructive shell commands are denied when shellDestructiveDecision is deny", async () => {
    let asked = false;
    const denyPolicy: PermissionPolicy = {
      ...policy,
      shellDestructiveDecision: "deny",
    };
    const gate = new PermissionGate(denyPolicy, async () => {
      asked = true;
      return "allow-once";
    });
    const res = await gate.authorize({
      toolCallId: "c1",
      toolName: "run_shell",
      args: { command: "rm -rf node_modules" },
      summary: "Run: rm -rf node_modules",
    });
    expect(res).toEqual({ allowed: false, decision: "deny" });
    expect(asked).toBe(false);
  });

  test("safe shell commands still bypass even when shellDestructiveDecision is deny", async () => {
    let asked = false;
    const denyPolicy: PermissionPolicy = {
      ...policy,
      shellDestructiveDecision: "deny",
    };
    const gate = new PermissionGate(denyPolicy, async () => {
      asked = true;
      return "allow-once";
    });
    const res = await gate.authorize({
      toolCallId: "c1",
      toolName: "run_shell",
      args: { command: "git status" },
      summary: "Run: git status",
    });
    expect(res).toEqual({ allowed: true, decision: "allow" });
    expect(asked).toBe(false);
  });

  test("unknown shell commands still prompt even when shellDestructiveDecision is deny", async () => {
    let asked = false;
    const denyPolicy: PermissionPolicy = {
      ...policy,
      shellDestructiveDecision: "deny",
    };
    const gate = new PermissionGate(denyPolicy, async () => {
      asked = true;
      return "allow-once";
    });
    const res = await gate.authorize({
      toolCallId: "c1",
      toolName: "run_shell",
      args: { command: "bun run build" },
      summary: "Run: bun run build",
    });
    expect(res.allowed).toBe(true);
    expect(res.decision).toBe("ask");
    expect(asked).toBe(true);
  });

  test("explicit deny still blocks safe shell commands", async () => {
    let asked = false;
    const gate = new PermissionGate(
      { defaultDecision: "ask", tools: { run_shell: "deny" } },
      async () => {
        asked = true;
        return "allow-once";
      },
    );
    const res = await gate.authorize({
      toolCallId: "c1",
      toolName: "run_shell",
      args: { command: "git status" },
      summary: "Run: git status",
    });
    expect(res).toEqual({ allowed: false, decision: "deny" });
    expect(asked).toBe(false);
  });
});
