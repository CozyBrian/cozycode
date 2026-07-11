import { expect, test } from "bun:test";
import { splitCommitDraft } from "../src/main/git-drafts.ts";

test("splits a CozyUtils-style commit draft after its blank line", () => {
  expect(splitCommitDraft("feat: add Git drafts\n\n- draft commit messages\n- copy PR descriptions\n")).toEqual({
    subject: "feat: add Git drafts",
    body: "- draft commit messages\n- copy PR descriptions",
  });
});

test("does not treat malformed prose as a commit body", () => {
  expect(splitCommitDraft("fix: preserve staged index\nextra prose")).toEqual({
    subject: "fix: preserve staged index",
    body: "",
  });
});
