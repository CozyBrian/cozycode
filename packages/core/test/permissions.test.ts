import { test, expect, describe } from "bun:test";
import type { SessionEvent } from "@cozycode/protocol";
import {
  PermissionService,
  PermissionDeniedError,
  PermissionRejectedError,
  PermissionCorrectedError,
  evaluateRule,
  type AskInput,
} from "../src/permission/service.ts";
import { rulesetFromConfig } from "../src/permission/config.ts";

function makeService(config: Parameters<typeof rulesetFromConfig>[0]) {
  const events: SessionEvent[] = [];
  const svc = new PermissionService(rulesetFromConfig(config), "s1", (e) => events.push(e));
  return { svc, events };
}

const bashAsk = (command: string): AskInput => ({
  permission: "bash",
  patterns: [command],
  always: [`${command.split(" ")[0]} *`],
  metadata: { command },
});

describe("evaluateRule", () => {
  test("last match wins across merged rulesets", () => {
    const rs = [
      ...rulesetFromConfig({ edit: "ask" }),
      ...rulesetFromConfig({ edit: "allow" }),
    ];
    expect(evaluateRule("edit", "x", rs).action).toBe("allow");
  });

  test("no match defaults to ask", () => {
    expect(evaluateRule("mystery", "x", []).action).toBe("ask");
  });
});

describe("PermissionService.ask", () => {
  test("all-allow returns silently and emits nothing", async () => {
    const { svc, events } = makeService({ read: "allow" });
    await svc.ask({ permission: "read", patterns: ["a.ts"], always: ["*"], metadata: {} });
    expect(events).toEqual([]);
  });

  test("a deny rule throws PermissionDeniedError without asking", async () => {
    const { svc, events } = makeService({ edit: "deny" });
    await expect(
      svc.ask({ permission: "edit", patterns: ["a.ts"], always: ["*"], metadata: {} }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(events).toEqual([]);
  });

  test("an ask parks the request and emits permission-asked", async () => {
    const { svc, events } = makeService({ edit: "ask" });
    const pending = svc.ask({ permission: "edit", patterns: ["a.ts"], always: ["*"], metadata: {} });
    // give the microtask a tick to register
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("permission-asked");
    expect(svc.listPending()).toHaveLength(1);
    svc.reply(svc.listPending()[0]!.id, "once");
    await pending;
  });
});

describe("PermissionService.reply", () => {
  test("once resolves the call", async () => {
    const { svc } = makeService({ edit: "ask" });
    const p = svc.ask({ permission: "edit", patterns: ["a.ts"], always: ["*"], metadata: {} });
    await Promise.resolve();
    svc.reply(svc.listPending()[0]!.id, "once");
    await expect(p).resolves.toBeUndefined();
  });

  test("unknown request id is a no-op", () => {
    const { svc } = makeService({ edit: "ask" });
    expect(() => svc.reply("per_999", "once")).not.toThrow();
  });

  test("concurrent asks are independently addressable (the hang regression)", async () => {
    const { svc } = makeService({ bash: "ask" });
    const a = svc.ask(bashAsk("foo one"));
    const b = svc.ask(bashAsk("bar two"));
    await Promise.resolve();
    expect(svc.listPending()).toHaveLength(2);

    // Reply to only the first; the second must stay pending, not be dropped.
    const [first, second] = svc.listPending();
    svc.reply(first!.id, "once");
    await expect(a).resolves.toBeUndefined();
    expect(svc.listPending().map((r) => r.id)).toEqual([second!.id]);

    svc.reply(second!.id, "once");
    await b;
  });

  test("always grants the request's always-patterns and unblocks covered siblings", async () => {
    const { svc, events } = makeService({ bash: "ask" });
    const a = svc.ask({
      permission: "bash",
      patterns: ["git commit -m x"],
      always: ["git commit *"],
      metadata: {},
    });
    const b = svc.ask({
      permission: "bash",
      patterns: ["git commit -m y"],
      always: ["git commit *"],
      metadata: {},
    });
    await Promise.resolve();
    expect(svc.listPending()).toHaveLength(2);

    // "always" on the first should auto-resolve the second (same prefix grant).
    svc.reply(svc.listPending()[0]!.id, "always");
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();
    expect(svc.listPending()).toHaveLength(0);

    const replied = events.filter((e) => e.type === "permission-replied");
    expect(replied.some((e) => e.type === "permission-replied" && e.reply === "always")).toBe(true);
  });

  test("reject cascades to all pending requests", async () => {
    const { svc, events } = makeService({ bash: "ask" });
    const a = svc.ask(bashAsk("aaa one"));
    const b = svc.ask(bashAsk("bbb two"));
    const c = svc.ask(bashAsk("ccc three"));
    await Promise.resolve();
    expect(svc.listPending()).toHaveLength(3);

    const results = Promise.allSettled([a, b, c]);
    svc.reply(svc.listPending()[0]!.id, "reject");
    const settled = await results;

    expect(settled.every((s) => s.status === "rejected")).toBe(true);
    expect(svc.listPending()).toHaveLength(0);
    const replied = events.filter((e) => e.type === "permission-replied");
    expect(replied).toHaveLength(3);
  });

  test("reject with a message produces a corrected error carrying feedback", async () => {
    const { svc } = makeService({ edit: "ask" });
    const p = svc.ask({ permission: "edit", patterns: ["a.ts"], always: ["*"], metadata: {} });
    await Promise.resolve();
    svc.reply(svc.listPending()[0]!.id, "reject", "use the API instead");
    await expect(p).rejects.toBeInstanceOf(PermissionCorrectedError);
    await p.catch((err) => {
      expect((err as Error).message).toContain("use the API instead");
    });
  });

  test("non-focal cascaded rejects carry no feedback", async () => {
    const { svc } = makeService({ bash: "ask" });
    const a = svc.ask(bashAsk("aaa one"));
    const b = svc.ask(bashAsk("bbb two"));
    await Promise.resolve();
    const settled = Promise.allSettled([a, b]);
    svc.reply(svc.listPending()[0]!.id, "reject", "focal feedback");
    const [ra, rb] = await settled;
    expect(ra.status).toBe("rejected");
    expect((ra as PromiseRejectedResult).reason).toBeInstanceOf(PermissionCorrectedError);
    expect((rb as PromiseRejectedResult).reason).toBeInstanceOf(PermissionRejectedError);
  });
});

describe("PermissionService lifecycle", () => {
  test("rejectAll fails everything and emits replied events", async () => {
    const { svc, events } = makeService({ bash: "ask" });
    const a = svc.ask(bashAsk("aaa one"));
    const b = svc.ask(bashAsk("bbb two"));
    await Promise.resolve();
    const settled = Promise.allSettled([a, b]);
    svc.rejectAll();
    const results = await settled;
    expect(results.every((s) => s.status === "rejected")).toBe(true);
    expect(events.filter((e) => e.type === "permission-replied")).toHaveLength(2);
  });

  test("setRuleset clears runtime always-grants", async () => {
    const { svc } = makeService({ bash: "ask" });
    // Grant "ls *" via always.
    const p = svc.ask({ permission: "bash", patterns: ["ls -la"], always: ["ls *"], metadata: {} });
    await Promise.resolve();
    svc.reply(svc.listPending()[0]!.id, "always");
    await p;

    // A fresh "ls" is now covered by the grant → resolves silently.
    await svc.ask({ permission: "bash", patterns: ["ls foo"], always: ["ls *"], metadata: {} });

    // Replacing the ruleset drops the grant → the next "ls" asks again.
    svc.setRuleset(rulesetFromConfig({ bash: "ask" }));
    const q = svc.ask({ permission: "bash", patterns: ["ls bar"], always: ["ls *"], metadata: {} });
    await Promise.resolve();
    expect(svc.listPending()).toHaveLength(1);
    svc.reply(svc.listPending()[0]!.id, "once");
    await q;
  });
});
