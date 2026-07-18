import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadTuiState,
  saveTuiState,
  tuiDataDirectory,
  tuiStateFile,
  TUI_RECENT_MODELS_LIMIT,
  type TuiState,
} from "../src/state.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cozycode-tui-state-"));
  process.env.COZY_STATE_FILE = join(root, "nested", "state.json");
});

afterEach(async () => {
  delete process.env.COZY_STATE_FILE;
  await rm(root, { recursive: true, force: true });
});

describe("TUI state", () => {
  test("migrates valid version 1 reasoning efforts", async () => {
    await writeState({
      version: 1,
      reasoningEffort: {
        "openai/gpt-5": "high",
        "anthropic/claude": 4,
        empty: "",
      },
    });

    expect(loadTuiState()).toEqual({
      version: 2,
      reasoningEffort: { "openai/gpt-5": "high" },
      recentModels: [],
      sidebarMode: "auto",
    });
  });

  test("drops corrupt and unknown fields without exposing untrusted values", async () => {
    await writeState({
      version: 2,
      reasoningEffort: ["high"],
      recentModels: [
        { providerID: "openai", modelID: "gpt-5", injected: true },
        { providerID: "openai", modelID: 5 },
        null,
      ],
      sidebarMode: "floating",
      unknown: { retained: false },
    });

    expect(loadTuiState()).toEqual({
      version: 2,
      reasoningEffort: {},
      recentModels: [{ providerID: "openai", modelID: "gpt-5" }],
      sidebarMode: "auto",
    });

    await writeFile(process.env.COZY_STATE_FILE!, "{broken", "utf8");
    expect(loadTuiState()).toEqual({
      version: 2,
      reasoningEffort: {},
      recentModels: [],
      sidebarMode: "auto",
    });

    await writeState({ version: 99, reasoningEffort: { unsafe: "high" } });
    expect(loadTuiState().reasoningEffort).toEqual({});
  });

  test("deduplicates and caps recent model refs on read and write", async () => {
    const recentModels = Array.from({ length: TUI_RECENT_MODELS_LIMIT + 4 }, (_, index) => ({
      providerID: "provider",
      modelID: `model-${index}`,
    }));
    recentModels.splice(1, 0, { ...recentModels[0]! });

    saveTuiState({
      version: 2,
      reasoningEffort: { "provider/model-0": "medium" },
      recentModels,
      sidebarMode: "closed",
    });

    const loaded = loadTuiState();
    expect(loaded.recentModels).toHaveLength(TUI_RECENT_MODELS_LIMIT);
    expect(loaded.recentModels[0]).toEqual({ providerID: "provider", modelID: "model-0" });
    expect(loaded.recentModels[1]).toEqual({ providerID: "provider", modelID: "model-1" });
    expect(new Set(loaded.recentModels.map((model) => `${model.providerID}/${model.modelID}`)).size).toBe(
      TUI_RECENT_MODELS_LIMIT,
    );
    expect(loaded.sidebarMode).toBe("closed");
  });

  test("atomically replaces state with owner-only file permissions", async () => {
    saveTuiState(state("open"));
    await chmod(process.env.COZY_STATE_FILE!, 0o644);
    saveTuiState(state("closed"));

    expect(JSON.parse(await readFile(process.env.COZY_STATE_FILE!, "utf8"))).toEqual(state("closed"));
    if (process.platform !== "win32") {
      expect((await stat(process.env.COZY_STATE_FILE!)).mode & 0o777).toBe(0o600);
    }
    expect(await readdir(join(root, "nested"))).toEqual(["state.json"]);
  });
});

describe("TUI paths", () => {
  test("uses platform data directories and environment overrides", () => {
    expect(tuiDataDirectory({}, "darwin", "/Users/test")).toBe(
      join("/Users/test", "Library", "Application Support", "CozyCode", "tui"),
    );
    expect(tuiDataDirectory({ APPDATA: "C:\\Users\\test\\AppData\\Roaming" }, "win32", "C:\\Users\\test")).toBe(
      join("C:\\Users\\test\\AppData\\Roaming", "CozyCode", "tui"),
    );
    expect(tuiDataDirectory({ XDG_DATA_HOME: "/data" }, "linux", "/home/test")).toBe(
      join("/data", "cozycode", "tui"),
    );
    expect(tuiStateFile({ COZY_STATE_FILE: "/tmp/custom-state.json" }, "/home/test")).toBe(
      "/tmp/custom-state.json",
    );
  });
});

async function writeState(value: unknown): Promise<void> {
  await mkdir(dirname(process.env.COZY_STATE_FILE!), { recursive: true });
  await writeFile(process.env.COZY_STATE_FILE!, JSON.stringify(value), "utf8");
}

function state(sidebarMode: TuiState["sidebarMode"]): TuiState {
  return {
    version: 2,
    reasoningEffort: { "openai/gpt-5": "high" },
    recentModels: [{ providerID: "openai", modelID: "gpt-5" }],
    sidebarMode,
  };
}
