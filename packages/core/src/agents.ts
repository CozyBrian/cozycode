import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentInfo, ModelRef, PermissionConfig, Ruleset } from "@cozycode/protocol";
import { mergeRulesets, READONLY_BASH_RULESET, rulesetFromConfig } from "./permission/config.ts";
import { evaluateRule } from "./permission/service.ts";

/** Read-only overlay for the built-in `explore` subagent: deny all but read + search. */
export const EXPLORE_RULESET: Ruleset = rulesetFromConfig({
  "*": "deny",
  read: "allow",
  search: "allow",
});

/** Built-in agents. `general` is a full general-purpose subagent; `explore` is read-only. */
export const BUILTIN_AGENTS: AgentInfo[] = [
  {
    name: "general",
    mode: "subagent",
    source: "builtin",
    description:
      "General-purpose agent for multi-step research, code search, and edits. Use for tasks you don't need to supervise step by step.",
  },
  {
    name: "explore",
    mode: "subagent",
    source: "builtin",
    description:
      "Read-only investigation agent — searches and reads files but cannot modify them. Use for broad codebase questions.",
  },
];

/**
 * Reapply safe shell commands after explore's catch-all deny, but only when the
 * parent had already allowed them. This retains explicit parent denials.
 */
function exploreBashRules(parentBase: Ruleset): Ruleset {
  return READONLY_BASH_RULESET.filter(
    (rule) => evaluateRule(rule.permission, rule.pattern, parentBase).action === "allow",
  );
}

/**
 * Derive the permission ruleset for a subagent's child session: inherit the
 * parent's base, overlay the read-only explore rules (for `explore`), overlay
 * the agent's own policy, and always deny `task` last so subagents can't spawn
 * further subagents (belt-and-suspenders — they also get no `task` tool built).
 */
export function deriveSubagentRuleset(parentBase: Ruleset, agent: AgentInfo): Ruleset {
  return mergeRulesets(
    parentBase,
    agent.name === "explore" ? EXPLORE_RULESET : [],
    agent.name === "explore" ? exploreBashRules(parentBase) : [],
    agent.permission ? rulesetFromConfig(agent.permission) : [],
    rulesetFromConfig({ task: "deny" }),
  );
}

/**
 * Parse a markdown-with-frontmatter agent file. Frontmatter is a minimal
 * `key: value` block (plus an optional one-level `tools:`/`permission:` map);
 * the markdown body becomes the agent's system prompt. Hand-rolled to avoid a
 * YAML dependency — only the shapes we document are supported.
 */
export function parseAgentMarkdown(name: string, raw: string): AgentInfo {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const frontmatter = match ? match[1]! : "";
  const body = (match ? match[2]! : raw).trim();

  const scalars: Record<string, string> = {};
  const maps: Record<string, Record<string, string>> = {};
  let currentMap: string | null = null;

  for (const line of frontmatter.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indented = /^\s+/.test(line);
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    if (indented && currentMap) {
      maps[currentMap]![key] = value;
      continue;
    }
    if (value === "" && (key === "tools" || key === "permission")) {
      currentMap = key;
      maps[key] = {};
      continue;
    }
    currentMap = null;
    scalars[key] = value;
  }

  const unquote = (v: string) => v.replace(/^["']|["']$/g, "");
  const num = (v?: string) => (v !== undefined && v !== "" ? Number(v) : undefined);
  const bool = (v?: string) => v === "true";

  let model: ModelRef | undefined;
  const modelStr = scalars.model ? unquote(scalars.model) : "";
  const slash = modelStr.indexOf("/");
  if (slash > 0) model = { providerID: modelStr.slice(0, slash), modelID: modelStr.slice(slash + 1) };

  // `permission` (category → action) wins over the `tools` (name → bool) shorthand.
  let permission: PermissionConfig | undefined;
  if (maps.permission) {
    permission = Object.fromEntries(
      Object.entries(maps.permission).map(([k, v]) => [k, unquote(v)]),
    ) as PermissionConfig;
  } else if (maps.tools) {
    permission = Object.fromEntries(
      Object.entries(maps.tools).map(([k, v]) => [k, bool(v) ? "allow" : "deny"]),
    ) as PermissionConfig;
  }

  const modeRaw = scalars.mode ? unquote(scalars.mode) : "";
  const mode: AgentInfo["mode"] =
    modeRaw === "primary" || modeRaw === "subagent" || modeRaw === "all" ? modeRaw : "all";

  return {
    name,
    mode,
    source: "config",
    description: scalars.description ? unquote(scalars.description) : undefined,
    model,
    prompt: body || undefined,
    permission,
    temperature: num(scalars.temperature),
    steps: num(scalars.steps ?? scalars.maxSteps),
    hidden: bool(scalars.hidden),
    color: scalars.color ? unquote(scalars.color) : undefined,
  };
}

async function loadDir(dir: string): Promise<AgentInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const agents: AgentInfo[] = [];
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    try {
      const raw = await readFile(join(dir, file), "utf8");
      agents.push(parseAgentMarkdown(basename(file, ".md"), raw));
    } catch {
      // Skip unreadable/malformed agent files.
    }
  }
  return agents;
}

/**
 * Load the agent registry: built-ins merged under user (`~/.config/cozycode/agents`)
 * merged under project (`<workspace>/.cozycode/agents`) config agents, by name
 * (project overrides user overrides built-in).
 */
export async function loadAgents(opts: { workspaceRoot: string }): Promise<AgentInfo[]> {
  const user = await loadDir(join(homedir(), ".config", "cozycode", "agents"));
  const project = await loadDir(join(opts.workspaceRoot, ".cozycode", "agents"));
  const byName = new Map<string, AgentInfo>();
  for (const agent of [...BUILTIN_AGENTS, ...user, ...project]) {
    byName.set(agent.name, agent);
  }
  return [...byName.values()];
}
