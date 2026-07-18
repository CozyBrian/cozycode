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
    openSessionPicker: () => calls.push("openSessionPicker"),
    undo: () => calls.push("undo"),
    redo: () => calls.push("redo"),
    forkSession: () => calls.push("forkSession"),
    deleteSession: () => calls.push("deleteSession"),
    openTimeline: () => calls.push("openTimeline"),
    openEditor: () => calls.push("openEditor"),
    openModelPicker: () => calls.push("openModelPicker"),
    openProviderPicker: () => calls.push("openProviderPicker"),
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

  test("parses the new command names and OpenCode aliases", () => {
    const names = [
      "undo",
      "redo",
      "fork",
      "delete",
      "timeline",
      "editor",
      "resume",
      "continue",
      "q",
    ];
    for (const name of names) {
      expect(parseCommandInput(`/${name}`)).toEqual({ name, args: "" });
    }
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

  test("registers the new session actions", () => {
    for (const name of ["undo", "redo", "fork", "delete", "timeline", "editor"]) {
      expect(findCommand(name)?.name).toBe(name);
    }
  });

  test("resolves OpenCode-compatible session and quit aliases", () => {
    expect(findCommand("resume")?.name).toBe("sessions");
    expect(findCommand("continue")?.name).toBe("sessions");
    expect(findCommand("q")?.name).toBe("quit");
  });

  test("canonical names and aliases do not conflict", () => {
    const names = new Set<string>();
    for (const command of listCommands({ includeHidden: true })) {
      for (const name of [command.name, ...(command.aliases ?? [])]) {
        expect(names.has(name)).toBe(false);
        names.add(name);
      }
    }
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

  test("dispatches the new session actions through available capabilities", async () => {
    const { ctx, calls } = recordingCtx();
    for (const name of ["undo", "redo", "fork", "delete", "timeline", "editor"]) {
      await runCommandInput(ctx, `/${name}`);
    }
    expect(calls).toEqual([
      "undo",
      "redo",
      "forkSession",
      "deleteSession",
      "openTimeline",
      "openEditor",
    ]);
  });

  test("new session actions report unavailable frontend capabilities", async () => {
    const recorded = recordingCtx();
    const ctx: CommandContext = {
      ...recorded.ctx,
      undo: undefined,
      redo: undefined,
      forkSession: undefined,
      deleteSession: undefined,
      openTimeline: undefined,
      openEditor: undefined,
    };
    for (const name of ["undo", "redo", "fork", "delete", "timeline", "editor"]) {
      await runCommandInput(ctx, `/${name}`);
    }
    expect(recorded.calls).toEqual([
      "notify:error:The /undo command is not supported by this frontend.",
      "notify:error:The /redo command is not supported by this frontend.",
      "notify:error:The /fork command is not supported by this frontend.",
      "notify:error:The /delete command is not supported by this frontend.",
      "notify:error:The /timeline command is not supported by this frontend.",
      "notify:error:The /editor command is not supported by this frontend.",
    ]);
  });

  test("dispatches the new aliases", async () => {
    const { ctx, calls } = recordingCtx();
    await runCommandInput(ctx, "/resume");
    await runCommandInput(ctx, "/continue");
    await runCommandInput(ctx, "/q");
    expect(calls).toEqual(["openSessionPicker", "openSessionPicker", "exit"]);
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
