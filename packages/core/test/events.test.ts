import { test, expect, describe } from "bun:test";
import { AsyncEventQueue } from "../src/events.ts";

describe("AsyncEventQueue", () => {
  test("delivers buffered items in order", async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    const got: number[] = [];
    for await (const n of q) got.push(n);
    expect(got).toEqual([1, 2]);
  });

  test("awaits items pushed after a consumer is waiting", async () => {
    const q = new AsyncEventQueue<string>();
    const collected: string[] = [];
    const consumer = (async () => {
      for await (const s of q) collected.push(s);
    })();
    q.push("a");
    await Promise.resolve();
    q.push("b");
    q.close();
    await consumer;
    expect(collected).toEqual(["a", "b"]);
  });

  test("push after close is ignored", async () => {
    const q = new AsyncEventQueue<number>();
    q.close();
    q.push(99);
    const got: number[] = [];
    for await (const n of q) got.push(n);
    expect(got).toEqual([]);
  });
});
