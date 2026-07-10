import { test, expect, describe } from "bun:test";
import type { ProviderList } from "@cozycode/protocol";
import {
  cycleEffort,
  effortsForModel,
  modelKey,
  resolveEffort,
  runCommandInput,
  type CommandContext,
} from "../src/index.ts";

const providers: ProviderList = {
  all: [
    {
      id: "openai",
      name: "OpenAI",
      source: "builtin",
      authMethods: [],
      models: [
        { id: "gpt-5.2", name: "GPT-5.2", reasoning: true, reasoningEfforts: ["none", "low", "medium", "high", "xhigh"] },
        { id: "gpt-4o", name: "GPT-4o" },
      ],
    },
  ],
  connected: ["openai"],
};

describe("modelKey / effortsForModel", () => {
  test("modelKey joins provider and model", () => {
    expect(modelKey({ providerID: "openai", modelID: "gpt-5.2" })).toBe("openai/gpt-5.2");
  });

  test("effortsForModel returns the model ladder, [] otherwise", () => {
    expect(effortsForModel(providers, { providerID: "openai", modelID: "gpt-5.2" })).toEqual([
      "none", "low", "medium", "high", "xhigh",
    ]);
    expect(effortsForModel(providers, { providerID: "openai", modelID: "gpt-4o" })).toEqual([]);
    expect(effortsForModel(providers, { providerID: "openai", modelID: "missing" })).toEqual([]);
    expect(effortsForModel(providers, null)).toEqual([]);
  });
});

describe("resolveEffort (stale-drop)", () => {
  const efforts = ["low", "medium", "high"];
  test("keeps a valid stored level", () => {
    expect(resolveEffort("high", efforts)).toBe("high");
  });
  test("drops a level not in the ladder", () => {
    expect(resolveEffort("xhigh", efforts)).toBeUndefined();
    expect(resolveEffort("high", [])).toBeUndefined();
    expect(resolveEffort(undefined, efforts)).toBeUndefined();
  });
});

describe("cycleEffort", () => {
  const efforts = ["low", "medium", "high"];
  test("default → first → … → last → default", () => {
    expect(cycleEffort(undefined, efforts)).toBe("low");
    expect(cycleEffort("low", efforts)).toBe("medium");
    expect(cycleEffort("medium", efforts)).toBe("high");
    expect(cycleEffort("high", efforts)).toBeUndefined();
  });
  test("unknown current wraps back to default", () => {
    expect(cycleEffort("bogus", efforts)).toBeUndefined();
  });
  test("empty ladder is a no-op", () => {
    expect(cycleEffort("low", [])).toBe("low");
    expect(cycleEffort(undefined, [])).toBeUndefined();
  });
});

describe("/effort command dispatch", () => {
  function recordingCtx() {
    const calls: string[] = [];
    const ctx: CommandContext = {
      setMode: () => {},
      newSession: () => {},
      openModelPicker: () => {},
      openProviderPicker: () => {},
      setEffort: (level) => calls.push(`setEffort:${level}`),
      openEffortPicker: () => calls.push("openEffortPicker"),
      showHelp: () => {},
      exit: () => {},
      send: () => {},
      notify: () => {},
    };
    return { ctx, calls };
  }

  test("with an arg calls setEffort", async () => {
    const { ctx, calls } = recordingCtx();
    await runCommandInput(ctx, "/effort high");
    expect(calls).toEqual(["setEffort:high"]);
  });

  test("bare command opens the picker", async () => {
    const { ctx, calls } = recordingCtx();
    await runCommandInput(ctx, "/effort");
    expect(calls).toEqual(["openEffortPicker"]);
  });

  test("the /reasoning alias resolves to the same command", async () => {
    const { ctx, calls } = recordingCtx();
    await runCommandInput(ctx, "/reasoning medium");
    expect(calls).toEqual(["setEffort:medium"]);
  });
});
