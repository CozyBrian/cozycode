import { describe, expect, test } from "bun:test";
import { createActionRegistry } from "../src/input/index.ts";

interface Context {
  calls: string[];
  enabled?: boolean;
}

describe("ActionRegistry", () => {
  test("dispatches direct and configurable bindings", () => {
    const registry = createActionRegistry<Context>([
      {
        name: "palette",
        bindings: "ctrl+p",
        run: (context) => void context.calls.push("palette"),
      },
    ]);
    const context = { calls: [] };

    expect(registry.dispatch({ name: "p", ctrl: true }, { context }).status).toBe("handled");
    registry.configure("palette", "ctrl+k");
    expect(registry.dispatch({ name: "p", ctrl: true }, { context }).status).toBe("unmatched");
    expect(registry.dispatch({ name: "k", ctrl: true }, { context }).status).toBe("handled");
    expect(context.calls).toEqual(["palette", "palette"]);
    expect(registry.bindings("palette")).toEqual(["ctrl+k"]);
  });

  test("uses ctrl+x as a timed leader and expires stale sequences", () => {
    let now = 100;
    const context = { calls: [] };
    const registry = createActionRegistry<Context>(
      [{ name: "model", bindings: "<leader>m", run: (value) => void value.calls.push("model") }],
      { now: () => now, leaderTimeoutMs: 500 },
    );

    expect(registry.dispatch({ name: "x", ctrl: true }, { context }).status).toBe("pending");
    now += 400;
    expect(registry.dispatch("m", { context }).status).toBe("handled");
    expect(context.calls).toEqual(["model"]);

    expect(registry.dispatch({ name: "x", ctrl: true }, { context }).status).toBe("pending");
    now += 500;
    expect(registry.dispatch("m", { context }).status).toBe("unmatched");
    expect(registry.isPending()).toBe(false);
  });

  test("escape cancels a pending leader without reaching escape actions", () => {
    const context = { calls: [] };
    const registry = createActionRegistry<Context>([
      { name: "model", bindings: "<leader>m", run: (value) => void value.calls.push("model") },
      { name: "close", bindings: "escape", run: (value) => void value.calls.push("close") },
    ]);

    registry.dispatch({ name: "x", ctrl: true }, { context });
    expect(registry.dispatch("escape", { context })).toMatchObject({ status: "handled", actions: [] });
    expect(context.calls).toEqual([]);
  });

  test("prefers the most specific scope", () => {
    const context = { calls: [] };
    const registry = createActionRegistry<Context>([
      { name: "base-up", scope: "base", bindings: "up", run: (value) => void value.calls.push("base") },
      { name: "prompt-up", scope: "prompt", bindings: "up", run: (value) => void value.calls.push("prompt") },
    ]);

    expect(registry.dispatch("up", { context, scopes: ["base", "prompt"] }).actions).toEqual(["prompt-up"]);
    expect(context.calls).toEqual(["prompt"]);
  });

  test("modal scopes suppress outer scopes but retain global bindings", () => {
    const context = { calls: [] };
    const registry = createActionRegistry<Context>([
      { name: "base", scope: "base", bindings: "b", run: (value) => void value.calls.push("base") },
      { name: "prompt", scope: "prompt", bindings: "p", run: (value) => void value.calls.push("prompt") },
      { name: "modal", scope: "dialog", bindings: "d", run: (value) => void value.calls.push("modal") },
      { name: "exit", scope: "global", bindings: "ctrl+c", run: (value) => void value.calls.push("exit") },
    ]);
    const scopes = ["base", "prompt", { name: "dialog", modal: true }] as const;

    expect(registry.dispatch("b", { context, scopes }).status).toBe("unmatched");
    expect(registry.dispatch("p", { context, scopes }).status).toBe("unmatched");
    expect(registry.dispatch("d", { context, scopes }).status).toBe("handled");
    expect(registry.dispatch({ name: "c", ctrl: true }, { context, scopes }).status).toBe("handled");
    expect(context.calls).toEqual(["modal", "exit"]);
  });

  test("fallthrough continues into lower scopes and can preserve native handling", () => {
    const context = { calls: [] };
    const registry = createActionRegistry<Context>([
      { name: "base", scope: "base", bindings: "tab", run: (value) => void value.calls.push("base") },
      {
        name: "prompt",
        scope: "prompt",
        bindings: { key: "tab", fallthrough: true, preventDefault: false },
        run: (value) => void value.calls.push("prompt"),
      },
    ]);

    expect(registry.dispatch("tab", { context, scopes: ["base", "prompt"] })).toEqual({
      status: "handled",
      actions: ["prompt", "base"],
      preventDefault: true,
    });
    expect(context.calls).toEqual(["prompt", "base"]);

    const native = createActionRegistry<Context>([
      {
        name: "paste",
        bindings: { key: "ctrl+v", fallthrough: true, preventDefault: false },
        run: (value) => void value.calls.push("paste"),
      },
    ]);
    expect(native.dispatch({ name: "v", ctrl: true }, { context })).toMatchObject({
      status: "fallthrough",
      preventDefault: false,
    });
  });

  test("reprocesses an unknown leader continuation as a fresh key", () => {
    const context = { calls: [] };
    const registry = createActionRegistry<Context>([
      { name: "model", bindings: "<leader>m", run: (value) => void value.calls.push("model") },
      { name: "type-q", bindings: "q", run: (value) => void value.calls.push("q") },
    ]);

    registry.dispatch({ name: "x", ctrl: true }, { context });
    expect(registry.dispatch("q", { context }).actions).toEqual(["type-q"]);
    expect(context.calls).toEqual(["q"]);
  });

  test("honors enabled predicates and emits external-store revisions", () => {
    const context: Context = { calls: [], enabled: false };
    const registry = createActionRegistry<Context>();
    let updates = 0;
    const unsubscribe = registry.subscribe(() => updates++);
    const unregister = registry.register({
      name: "conditional",
      bindings: "c",
      enabled: (value) => value.enabled === true,
      run: (value) => void value.calls.push("conditional"),
    });
    const revision = registry.getSnapshot();

    expect(registry.dispatch("c", { context }).status).toBe("unmatched");
    context.enabled = true;
    expect(registry.dispatch("c", { context }).status).toBe("handled");
    expect(registry.getSnapshot()).toBeGreaterThan(revision);
    unregister();
    unsubscribe();
    expect(updates).toBeGreaterThanOrEqual(3);
  });
});
