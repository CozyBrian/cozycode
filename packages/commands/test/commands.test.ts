import { test, expect, describe } from "bun:test";
import {
  findCommand,
  listCommands,
  matchPrefix,
  parseCommandInput,
  runCommandInput,
  tokenizeArgs,
  type CommandContext,
} from "../src/index.ts";

/** A CommandContext that records which capability was invoked. */
function recordingCtx() {
  const calls: string[] = [];
  const ctx: CommandContext = {
    setMode: (m) => calls.push(`setMode:${m}`),
    setModel: (id) => calls.push(`setModel:${id}`),
    newSession: () => calls.push("newSession"),
    openModelPicker: () => calls.push("openModelPicker"),
    showHelp: () => calls.push("showHelp"),
    exit: () => calls.push("exit"),
    send: (t) => calls.push(`send:${t}`),
    notify: (kind, text) => calls.push(`notify:${kind}:${text}`),
  };
  return { ctx, calls };
}

describe("parseCommandInput", () => {
  test("returns null for plain text", () => {
    expect(parseCommandInput("hello world")).toBeNull();
    expect(parseCommandInput("  /leading-space")).toBeNull();
  });

  test("splits name and args", () => {
    expect(parseCommandInput("/model")).toEqual({ name: "model", args: "" });
    expect(parseCommandInput("/model gpt-4o")).toEqual({ name: "model", args: "gpt-4o" });
  });

  test("lowercases the name and keeps arg casing", () => {
    expect(parseCommandInput("/MODEL GPT-4o")).toEqual({ name: "model", args: "GPT-4o" });
  });

  test("keeps trailing lines as args", () => {
    expect(parseCommandInput("/ask what is\nthis")).toEqual({ name: "ask", args: "what is\nthis" });
  });

  test("null when only a slash", () => {
    expect(parseCommandInput("/")).toBeNull();
  });
});

describe("tokenizeArgs", () => {
  test("splits on whitespace", () => {
    expect(tokenizeArgs("a b c")).toEqual(["a", "b", "c"]);
  });

  test("respects quotes and strips them", () => {
    expect(tokenizeArgs('"two words" solo')).toEqual(["two words", "solo"]);
    expect(tokenizeArgs("'single quoted'")).toEqual(["single quoted"]);
  });

  test("empty for blank input", () => {
    expect(tokenizeArgs("   ")).toEqual([]);
  });
});

describe("findCommand", () => {
  test("resolves canonical names and aliases", () => {
    expect(findCommand("new")?.name).toBe("new");
    expect(findCommand("clear")?.name).toBe("new");
    expect(findCommand("models")?.name).toBe("model");
    expect(findCommand("exit")?.name).toBe("quit");
  });

  test("case-insensitive", () => {
    expect(findCommand("PLAN")?.name).toBe("plan");
  });

  test("unknown returns undefined", () => {
    expect(findCommand("nope")).toBeUndefined();
  });
});

describe("matchPrefix", () => {
  test("matches by name and alias prefix", () => {
    expect(matchPrefix("mo").map((c) => c.name)).toContain("model");
    expect(matchPrefix("cl").map((c) => c.name)).toContain("new"); // via alias "clear"
  });

  test("empty query lists all visible commands", () => {
    expect(matchPrefix("").length).toBe(listCommands().length);
  });
});

describe("runCommandInput", () => {
  test("dispatches a known command through the context", async () => {
    const { ctx, calls } = recordingCtx();
    expect(await runCommandInput(ctx, "/plan")).toBe(true);
    expect(calls).toEqual(["setMode:plan"]);
  });

  test("/model with an id uses setModel, without opens the picker", async () => {
    const withId = recordingCtx();
    await runCommandInput(withId.ctx, "/model gpt-4o");
    expect(withId.calls).toEqual(["setModel:gpt-4o"]);

    const noId = recordingCtx();
    await runCommandInput(noId.ctx, "/model");
    expect(noId.calls).toEqual(["openModelPicker"]);
  });

  test("unknown command notifies and is still handled", async () => {
    const { ctx, calls } = recordingCtx();
    expect(await runCommandInput(ctx, "/nope")).toBe(true);
    expect(calls).toEqual(["notify:error:Unknown command: /nope"]);
  });

  test("plain text is not handled", async () => {
    const { ctx, calls } = recordingCtx();
    expect(await runCommandInput(ctx, "just chatting")).toBe(false);
    expect(calls).toEqual([]);
  });
});
