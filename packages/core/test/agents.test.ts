import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_AGENTS,
  DEFAULT_RULESET,
  deriveSubagentRuleset,
  evaluateRule,
  loadAgents,
  mergeRulesets,
  parseAgentMarkdown,
  rulesetFromConfig,
} from "../src/index.ts";

describe("parseAgentMarkdown", () => {
  test("parses frontmatter scalars, tools map, and body prompt", () => {
    const raw = [
      "---",
      "description: Reviews diffs",
      "mode: subagent",
      "model: openai/gpt-5.2",
      "temperature: 0.2",
      "steps: 15",
      "tools:",
      "  edit: false",
      "  read: true",
      "---",
      "You are a careful code reviewer.",
      "Be concise.",
    ].join("\n");
    const agent = parseAgentMarkdown("reviewer", raw);
    expect(agent.name).toBe("reviewer");
    expect(agent.mode).toBe("subagent");
    expect(agent.description).toBe("Reviews diffs");
    expect(agent.model).toEqual({ providerID: "openai", modelID: "gpt-5.2" });
    expect(agent.temperature).toBe(0.2);
    expect(agent.steps).toBe(15);
    expect(agent.prompt).toBe("You are a careful code reviewer.\nBe concise.");
    expect(agent.permission).toEqual({ edit: "deny", read: "allow" });
    expect(agent.source).toBe("config");
  });

  test("defaults mode to 'all' and body-only files have no frontmatter", () => {
    const agent = parseAgentMarkdown("helper", "Just a prompt, no frontmatter.");
    expect(agent.mode).toBe("all");
    expect(agent.prompt).toBe("Just a prompt, no frontmatter.");
  });
});

describe("loadAgents", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cozycode-agents-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("project agents override built-ins by name; built-ins remain", async () => {
    const dir = join(root, ".cozycode", "agents");
    await mkdir(dir, { recursive: true });
    // Override the built-in `explore`, and add a new `reviewer`.
    await writeFile(join(dir, "explore.md"), "---\ndescription: custom explore\nmode: subagent\n---\nbody", "utf8");
    await writeFile(join(dir, "reviewer.md"), "---\nmode: subagent\n---\nreview", "utf8");
    const agents = await loadAgents({ workspaceRoot: root });
    const explore = agents.find((a) => a.name === "explore")!;
    expect(explore.description).toBe("custom explore");
    expect(explore.source).toBe("config");
    expect(agents.some((a) => a.name === "reviewer")).toBe(true);
    expect(agents.some((a) => a.name === "general")).toBe(true); // built-in survives
  });

  test("no config dirs returns just the built-ins", async () => {
    const agents = await loadAgents({ workspaceRoot: root });
    expect(agents.map((a) => a.name).sort()).toEqual(BUILTIN_AGENTS.map((a) => a.name).sort());
  });
});

describe("deriveSubagentRuleset", () => {
  const base = rulesetFromConfig({ "*": "ask", read: "allow", edit: "ask", task: "allow" });

  test("explore is read-only and cannot spawn subagents", () => {
    const explore = BUILTIN_AGENTS.find((a) => a.name === "explore")!;
    const ruleset = deriveSubagentRuleset(base, explore);
    expect(evaluateRule("read", "x", ruleset).action).toBe("allow");
    expect(evaluateRule("edit", "x", ruleset).action).toBe("deny");
    expect(evaluateRule("task", "general", ruleset).action).toBe("deny");
  });

  test("explore retains reads but denies every shell command", () => {
    const explore = BUILTIN_AGENTS.find((agent) => agent.name === "explore")!;
    const ruleset = deriveSubagentRuleset(DEFAULT_RULESET, explore);
    expect(evaluateRule("read", "apps/desktop/package.json", ruleset).action).toBe("allow");
    expect(evaluateRule("bash", "ls apps/desktop", ruleset).action).toBe("deny");
    expect(evaluateRule("bash", "find apps/desktop -delete", ruleset).action).toBe("deny");
    expect(evaluateRule("bash", "rm -rf build", ruleset).action).toBe("deny");
  });

  test("general inherits the parent base but still can't spawn subagents", () => {
    const general = BUILTIN_AGENTS.find((a) => a.name === "general")!;
    const ruleset = deriveSubagentRuleset(base, general);
    expect(evaluateRule("read", "x", ruleset).action).toBe("allow");
    expect(evaluateRule("task", "general", ruleset).action).toBe("deny");
  });

  test("a config agent's own permission overlays the base", () => {
    const ruleset = deriveSubagentRuleset(base, {
      name: "reviewer",
      mode: "subagent",
      source: "config",
      permission: { edit: "deny" },
    });
    expect(evaluateRule("edit", "x", ruleset).action).toBe("deny");
  });
});
