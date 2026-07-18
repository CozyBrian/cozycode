import { describe, expect, test } from "bun:test";
import { createPromptDraftStore, SessionDraftStore } from "../src/prompt/index.ts";

describe("session drafts", () => {
  test("isolates sessions and increments revisions", () => {
    const store = createPromptDraftStore();
    const first = store.set("one", { text: "hello", cursor: 5, mode: "normal" });
    const second = store.set("two", { text: "world", cursor: 5, mode: "shell" });

    expect(first.snapshot.revision).toBe(1);
    expect(second.snapshot.revision).toBe(1);
    expect(store.get("one").value.text).toBe("hello");
    expect(store.get("two").value.mode).toBe("shell");
  });

  test("rejects stale compare-and-swap updates", () => {
    const store = createPromptDraftStore();
    const captured = store.get("session");
    store.set("session", { text: "new", cursor: 3, mode: "normal" }, captured.revision);
    const stale = store.set("session", { text: "old", cursor: 3, mode: "normal" }, captured.revision);

    expect(stale.applied).toBe(false);
    expect(stale.snapshot.value.text).toBe("new");
    expect(stale.snapshot.revision).toBe(1);
  });

  test("normalizes cursors and supports functional updates and resets", () => {
    const store = createPromptDraftStore({ text: "seed", cursor: 99 });
    expect(store.get("session").value.cursor).toBe(4);

    const updated = store.update("session", (draft) => ({ ...draft, text: "x", cursor: -20 }));
    expect(updated.snapshot.value.cursor).toBe(0);
    const reset = store.reset("session", updated.snapshot.revision);
    expect(reset.snapshot.value).toMatchObject({ text: "seed", cursor: 4, mode: "normal" });
  });

  test("provides global and session-scoped subscriptions", () => {
    const store = new SessionDraftStore({ initial: 0 });
    let global = 0;
    let one = 0;
    store.subscribe(() => global++);
    store.subscribeSession("one", () => one++);

    store.set("one", 1);
    store.set("two", 2);
    expect({ global, one }).toEqual({ global: 2, one: 1 });
    expect(store.snapshot("one")()).toBe(store.get("one"));
  });
});
