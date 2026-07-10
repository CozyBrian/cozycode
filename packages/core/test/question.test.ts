import { test, expect, describe } from "bun:test";
import type { QuestionSpec, SessionEvent } from "@cozycode/protocol";
import { QuestionService, QuestionRejectedError } from "../src/index.ts";

function makeService() {
  const events: SessionEvent[] = [];
  const service = new QuestionService("sess-1", (e) => events.push(e));
  return { service, events };
}

const spec: QuestionSpec[] = [
  { question: "Which DB?", header: "DB", options: [{ label: "Postgres" }, { label: "MySQL" }] },
];

describe("QuestionService", () => {
  test("ask parks and emits question-asked", async () => {
    const { service, events } = makeService();
    const promise = service.ask({ questions: spec });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("question-asked");
    const id = service.listPending()[0]!.id;
    expect(id).toBe("qst_1");
    service.answer(id, [["Postgres"]]);
    await expect(promise).resolves.toEqual([["Postgres"]]);
  });

  test("answer emits question-answered and clears pending", async () => {
    const { service, events } = makeService();
    const promise = service.ask({ questions: spec });
    const id = service.listPending()[0]!.id;
    service.answer(id, [["MySQL"]]);
    await promise;
    expect(events.map((e) => e.type)).toEqual(["question-asked", "question-answered"]);
    expect(service.listPending()).toHaveLength(0);
  });

  test("reject rejects with QuestionRejectedError and emits question-rejected", async () => {
    const { service, events } = makeService();
    const promise = service.ask({ questions: spec });
    const id = service.listPending()[0]!.id;
    service.reject(id, "changed my mind");
    await expect(promise).rejects.toBeInstanceOf(QuestionRejectedError);
    expect(events.at(-1)!.type).toBe("question-rejected");
  });

  test("rejectAll clears everything", async () => {
    const { service } = makeService();
    // Attach the rejection handlers before rejecting so the rejections are caught.
    const a = expect(service.ask({ questions: spec })).rejects.toBeInstanceOf(QuestionRejectedError);
    const b = expect(service.ask({ questions: spec })).rejects.toBeInstanceOf(QuestionRejectedError);
    service.rejectAll();
    await Promise.all([a, b]);
    expect(service.listPending()).toHaveLength(0);
  });

  test("answer/reject with an unknown id is a no-op", () => {
    const { service } = makeService();
    expect(() => service.answer("nope", [["x"]])).not.toThrow();
    expect(() => service.reject("nope")).not.toThrow();
  });
});
