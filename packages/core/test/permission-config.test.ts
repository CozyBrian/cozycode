import { test, expect, describe } from "bun:test";
import { homedir } from "node:os";
import {
  rulesetFromConfig,
  mergeRulesets,
  DEFAULT_RULESET,
  FULL_ACCESS_RULESET,
} from "../src/permission/config.ts";
import { evaluateRule } from "../src/permission/service.ts";

describe("rulesetFromConfig", () => {
  test("bare action normalizes to a single wildcard rule", () => {
    expect(rulesetFromConfig("allow")).toEqual([
      { permission: "*", pattern: "*", action: "allow" },
    ]);
  });

  test("category → action applies to every pattern", () => {
    expect(rulesetFromConfig({ edit: "deny" })).toEqual([
      { permission: "edit", pattern: "*", action: "deny" },
    ]);
  });

  test("per-pattern map preserves key order", () => {
    const rs = rulesetFromConfig({ bash: { "*": "ask", "ls *": "allow" } });
    expect(rs.map((r) => r.pattern)).toEqual(["*", "ls *"]);
  });

  test("expands ~ and $HOME in patterns", () => {
    const rs = rulesetFromConfig({ edit: { "~/secrets/*": "deny", "$HOME/x": "deny" } });
    expect(rs[0]!.pattern).toBe(homedir() + "/secrets/*");
    expect(rs[1]!.pattern).toBe(homedir() + "/x");
  });
});

describe("mergeRulesets precedence", () => {
  test("later rules win (last match)", () => {
    const merged = mergeRulesets(
      rulesetFromConfig({ edit: "ask" }),
      rulesetFromConfig({ edit: "allow" }),
    );
    expect(evaluateRule("edit", "any/path", merged).action).toBe("allow");
  });
});

describe("DEFAULT_RULESET", () => {
  const evalBash = (cmd: string) => evaluateRule("bash", cmd, DEFAULT_RULESET).action;

  test("reads and searches are allowed", () => {
    expect(evaluateRule("read", "a.ts", DEFAULT_RULESET).action).toBe("allow");
    expect(evaluateRule("search", "foo", DEFAULT_RULESET).action).toBe("allow");
  });

  test("edits ask by default", () => {
    expect(evaluateRule("edit", "a.ts", DEFAULT_RULESET).action).toBe("ask");
  });

  test("all shell commands ask by default", () => {
    expect(evalBash("git status")).toBe("ask");
    expect(evalBash("ls -la")).toBe("ask");
    expect(evalBash("bun run test")).toBe("ask");
    expect(evalBash("rm -rf x")).toBe("ask");
    expect(evalBash("git commit -m x")).toBe("ask");
  });
});

describe("FULL_ACCESS_RULESET", () => {
  test("allows everything", () => {
    expect(evaluateRule("edit", "a.ts", FULL_ACCESS_RULESET).action).toBe("allow");
    expect(evaluateRule("bash", "rm -rf /", FULL_ACCESS_RULESET).action).toBe("allow");
  });
});
