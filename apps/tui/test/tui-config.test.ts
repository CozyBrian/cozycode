import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadTuiConfig, tuiConfigDirectory } from "../src/tui-config.ts";

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-tui-config-"));
  env = {};
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("loadTuiConfig", () => {
  test("parses comments and trailing commas without changing strings", async () => {
    await writeConfig("tui.jsonc", `{
      "$schema": "https://example.test/schema//literal/*text*/",
      // Keep the timeout short while testing.
      "leader_timeout": 750,
      "keybinds": {
        "leader": "ctrl+g", /* a block comment */
        "session.new": ["<leader>n", "ctrl+shift+n",],
        "app.quit": "ctrl+/",
      },
    }`);

    expect(loadTuiConfig(env, "linux", root)).toEqual({
      config: {
        leader: "ctrl+g",
        leaderTimeoutMs: 750,
        keybinds: {
          "session.new": ["<leader>n", "ctrl+shift+n"],
          "app.quit": "ctrl+/",
        },
      },
      diagnostics: [],
    });
  });

  test("merges JSON, JSONC, and the explicit environment override", async () => {
    await writeConfig("tui.json", JSON.stringify({
      leader_timeout: 100,
      keybinds: { "session.new": "ctrl+n", "app.quit": "ctrl+q" },
    }));
    await writeConfig("tui.jsonc", `{
      "keybinds": { "session.new": "<leader>n", },
    }`);
    const override = join(root, "override.jsonc");
    await writeFile(override, `{
      "leader_timeout": 300,
      "keybinds": { "app.quit": false, },
    }`, "utf8");
    env.COZY_TUI_CONFIG = override;

    expect(loadTuiConfig(env, "linux", root)).toEqual({
      config: {
        leaderTimeoutMs: 300,
        keybinds: { "session.new": "<leader>n", "app.quit": false },
      },
      diagnostics: [],
    });
  });

  test("keeps valid overrides and reports invalid keybinds and fields", async () => {
    await writeConfig("tui.json", JSON.stringify({
      leader_timeout: -4,
      extra: true,
      keybinds: {
        leader: "<leader>",
        "session.new": 4,
        "session.list": ["ctrl+l", false],
        "sidebar.toggle": "unknown+m",
        "app.quit": "none",
        "app.exit": false,
        "not.an.action": "ctrl+n",
      },
    }));

    const loaded = loadTuiConfig(env, "linux", root);
    expect(loaded.config).toEqual({
      keybinds: { "app.quit": "none", "app.exit": false },
    });
    expect(loaded.diagnostics.some((message) => message.includes("leader_timeout"))).toBe(true);
    expect(loaded.diagnostics.some((message) => message.includes("unknown config field"))).toBe(true);
    expect(loaded.diagnostics.some((message) => message.includes("keybinds.leader"))).toBe(true);
    expect(loaded.diagnostics.some((message) => message.includes("session.new"))).toBe(true);
    expect(loaded.diagnostics.some((message) => message.includes("session.list"))).toBe(true);
    expect(loaded.diagnostics.some((message) => message.includes("sidebar.toggle"))).toBe(true);
    expect(loaded.diagnostics.some((message) => message.includes("not.an.action"))).toBe(true);
  });

  test("returns partial defaults with diagnostics for malformed or unreadable files", async () => {
    await writeConfig("tui.jsonc", "{/* unterminated");
    env.COZY_TUI_CONFIG = join(root, "missing.json");

    const loaded = loadTuiConfig(env, "linux", root);
    expect(loaded.config).toEqual({});
    expect(loaded.diagnostics).toHaveLength(2);
    expect(loaded.diagnostics[0]).toContain("unterminated block comment");
    expect(loaded.diagnostics[1]).toContain("missing.json");
  });
});

describe("TUI config paths", () => {
  test("uses normal platform config directories", () => {
    expect(tuiConfigDirectory({}, "darwin", "/Users/test")).toBe(
      join("/Users/test", ".config", "cozycode"),
    );
    expect(tuiConfigDirectory({ XDG_CONFIG_HOME: "/config" }, "linux", "/home/test")).toBe(
      join("/config", "cozycode"),
    );
    expect(tuiConfigDirectory({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "win32", "C:\\Users\\test")).toBe(
      join("C:\\Users\\test\\AppData\\Roaming", "CozyCode"),
    );
  });
});

async function writeConfig(name: string, contents: string): Promise<void> {
  const file = join(tuiConfigDirectory(env, "linux", root), name);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}
