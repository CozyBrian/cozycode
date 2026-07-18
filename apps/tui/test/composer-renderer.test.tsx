import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import {
  Composer,
  type ComposerDraft,
  type ComposerDraftUpdate,
  type ComposerHandle,
  type ComposerProps,
  type ComposerSubmission,
  type ComposerStatus,
} from "../src/components/composer/index.ts";

const renderers = new Set<TestRendererSetup>();

afterEach(() => {
  for (const rendered of renderers) rendered.renderer.destroy();
  renderers.clear();
});

interface HarnessOptions {
  draft?: ComposerDraft;
  status?: ComposerStatus;
  commands?: ComposerProps["commandCandidates"];
  files?: ComposerProps["fileCandidates"];
  history?: ComposerProps["historyEntries"];
  onSubmit?: ComposerProps["onSubmit"];
  onSubmitError?: ComposerProps["onSubmitError"];
}

function harness(options: HarnessOptions = {}) {
  let handle: ComposerHandle | null = null;
  let latestDraft = options.draft ?? { text: "", revision: 0 };
  let mode: ComposerProps["mode"] = "build";

  function Harness() {
    const [draft, setDraft] = useState<ComposerDraft>(latestDraft);
    const [agentMode, setAgentMode] = useState<ComposerProps["mode"]>(mode);

    function updateDraft(update: ComposerDraftUpdate) {
      setDraft((current) => {
        if (current.revision !== update.expectedRevision) return current;
        latestDraft = {
          text: update.text,
          revision: current.revision + 1,
          cursor: update.cursor,
          promptMode: update.promptMode,
          pastePlaceholders: update.pastePlaceholders,
        };
        return latestDraft;
      });
    }

    return (
      <Composer
        ref={(value) => {
          handle = value;
        }}
        sessionID="session-1"
        draft={draft}
        status={options.status ?? "idle"}
        modelLabel="claude-sonnet"
        mode={agentMode}
        effortLabel="high"
        workspaceLabel="~/cozycode"
        commandCandidates={options.commands ?? [
          { name: "help", description: "Show help" },
          { name: "model", aliases: ["models"], description: "Switch model" },
        ]}
        fileCandidates={options.files ?? [
          { path: "src", directory: true },
          { path: "src/index.ts", description: "entrypoint" },
        ]}
        historyEntries={options.history ?? []}
        onDraftChange={updateDraft}
        onSubmit={options.onSubmit ?? (() => true)}
        onSubmitError={options.onSubmitError}
        onModeChange={(next) => {
          mode = next;
          setAgentMode(next);
        }}
      />
    );
  }

  return {
    element: <Harness />,
    handle: () => {
      if (!handle) throw new Error("Composer ref is not mounted");
      return handle;
    },
    mode: () => mode,
  };
}

async function render(element: React.ReactNode, height = 24) {
  const rendered = await testRender(element, { width: 90, height, kittyKeyboard: true });
  renderers.add(rendered);
  await act(async () => {
    await rendered.flush();
  });
  setActEnvironment(false);
  return rendered;
}

async function interact(rendered: TestRendererSetup, callback: () => void | Promise<void>) {
  // OpenTUI stdin is an external event source, not a React synthetic event.
  // Drain its parser and renderer with the act environment disabled.
  await callback();
  await new Promise((resolve) => setTimeout(resolve, 40));
  await rendered.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rendered.flush();
}

function setActEnvironment(value: boolean) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = value;
}

describe("Composer renderer", () => {
  test("preserves the controlled draft when submit does not clear parent state", async () => {
    const submissions: ComposerSubmission[] = [];
    const subject = harness({ onSubmit: (submission) => submissions.push(submission) > 0 });
    const rendered = await render(subject.element);

    await interact(rendered, () => rendered.mockInput.typeText("keep this draft"));
    await interact(rendered, () => rendered.mockInput.pressEnter());

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.displayText).toBe("keep this draft");
    expect(subject.handle().current.text).toBe("keep this draft");
    expect(rendered.captureCharFrame()).toContain("keep this draft");
  });

  test("preserves the draft after false and failed submits", async () => {
    const failure = new Error("send failed");
    const errors: unknown[] = [];
    let attempts = 0;
    const subject = harness({
      onSubmit: async () => {
        if (attempts++ === 0) return false;
        throw failure;
      },
      onSubmitError: (error) => errors.push(error),
    });
    const rendered = await render(subject.element);

    await interact(rendered, () => rendered.mockInput.typeText("retry me"));
    await interact(rendered, () => rendered.mockInput.pressEnter());

    expect(errors).toHaveLength(0);
    expect(subject.handle().current.text).toBe("retry me");

    await interact(rendered, () => rendered.mockInput.pressEnter());

    expect(errors).toEqual([failure]);
    expect(subject.handle().current.text).toBe("retry me");
  });

  test("inserts newlines for Shift/Ctrl/Alt+Enter and Ctrl+J", async () => {
    const submissions: ComposerSubmission[] = [];
    const subject = harness({ onSubmit: (submission) => void submissions.push(submission) });
    const rendered = await render(subject.element);

    await interact(rendered, async () => {
      await rendered.mockInput.typeText("a");
      rendered.mockInput.pressEnter({ shift: true });
      await rendered.mockInput.typeText("b");
      rendered.mockInput.pressEnter({ ctrl: true });
      await rendered.mockInput.typeText("c");
      rendered.mockInput.pressEnter({ meta: true });
      await rendered.mockInput.typeText("d");
      rendered.mockInput.pressKey("j", { ctrl: true });
      await rendered.mockInput.typeText("e");
    });

    expect(subject.handle().current.text).toBe("a\nb\nc\nd\ne");
    expect(submissions).toHaveLength(0);
  });

  test("fuzzy-completes slash commands and lets autocomplete own Tab", async () => {
    const subject = harness();
    const rendered = await render(subject.element);

    await interact(rendered, () => rendered.mockInput.typeText("/mdl"));
    expect(rendered.captureCharFrame()).toContain("/model");

    await interact(rendered, () => rendered.mockInput.pressTab());
    expect(subject.handle().current.text).toBe("/model ");
    expect(subject.mode()).toBe("build");

    await interact(rendered, () => rendered.mockInput.pressTab());
    expect(subject.mode()).toBe("plan");
  });

  test("completes file line ranges and expands directories", async () => {
    const fileSubject = harness();
    const fileRendered = await render(fileSubject.element);

    await interact(fileRendered, () => fileRendered.mockInput.typeText("Use @src/ind#10-20"));
    expect(fileRendered.captureCharFrame()).toContain("@src/index.ts");
    await interact(fileRendered, () => fileRendered.mockInput.pressEnter());
    expect(fileSubject.handle().current.text).toBe("Use @src/index.ts#10-20 ");

    fileRendered.renderer.destroy();
    renderers.delete(fileRendered);

    const directorySubject = harness();
    const directoryRendered = await render(directorySubject.element);
    await interact(directoryRendered, () => directoryRendered.mockInput.typeText("@sr"));
    await interact(directoryRendered, () => directoryRendered.mockInput.pressTab());
    expect(directorySubject.handle().current.text).toBe("@src/");
    expect(directoryRendered.captureCharFrame()).toContain("@src/index.ts");
  });

  test("supports mouse selection and Escape dismissal without propagating", async () => {
    let escaped = 0;
    let handle: ComposerHandle | null = null;
    const rendered = await render(
      <Composer
        ref={(value) => {
          handle = value;
        }}
        sessionID="mouse"
        draft={{ text: "", revision: 0 }}
        status="idle"
        modelLabel="model"
        mode="build"
        workspaceLabel="workspace"
        commandCandidates={[{ name: "model", description: "Switch model" }]}
        fileCandidates={[]}
        historyEntries={[]}
        onDraftChange={() => {}}
        onSubmit={() => true}
        onModeChange={() => {}}
        onEscape={() => escaped++}
      />,
    );

    await interact(rendered, () => rendered.mockInput.typeText("/mo"));
    const row = rendered.renderer.root.findDescendantById("composer-suggestion-0");
    if (!row) throw new Error("Suggestion row was not rendered");
    await interact(rendered, () => rendered.mockMouse.click(row.screenX + 1, row.screenY));
    expect(handle?.current.text).toBe("/model ");

    await interact(rendered, () => {
      rendered.mockInput.pressKey("a", { super: true });
      rendered.mockInput.pressBackspace();
    });
    await interact(rendered, () => rendered.mockInput.typeText("/mo"));
    await interact(rendered, () => rendered.mockInput.pressEscape());
    expect(escaped).toBe(0);
    expect(rendered.captureCharFrame()).not.toContain("Switch model");
  });

  test("enters shell mode with leading bang and exits on Escape or empty Backspace", async () => {
    const submissions: ComposerSubmission[] = [];
    const subject = harness({ onSubmit: (submission) => void submissions.push(submission) });
    const rendered = await render(subject.element);

    await interact(rendered, () => rendered.mockInput.typeText("!"));
    expect(subject.handle().current.promptMode).toBe("shell");
    expect(subject.handle().current.text).toBe("");
    expect(rendered.captureCharFrame()).toContain("SHELL");

    await interact(rendered, () => rendered.mockInput.pressBackspace());
    expect(subject.handle().current.promptMode).toBe("normal");

    await interact(rendered, async () => {
      await rendered.mockInput.typeText("!");
      await rendered.mockInput.typeText("pwd");
      rendered.mockInput.pressEscape();
    });
    expect(subject.handle().current.promptMode).toBe("normal");
    expect(subject.handle().current.text).toBe("pwd");

    await interact(rendered, () => {
      rendered.mockInput.pressKey("a", { super: true });
      rendered.mockInput.pressBackspace();
    });
    await interact(rendered, async () => {
      await rendered.mockInput.typeText("!");
      await rendered.mockInput.typeText("ls -la");
      rendered.mockInput.pressEnter();
    });
    expect(submissions.at(-1)?.kind).toBe("shell");
    expect(submissions.at(-1)?.displayText).toBe("ls -la");
  });

  test("navigates history at input boundaries and restores the original draft", async () => {
    const subject = harness({
      draft: { text: "working draft", revision: 0, cursor: 0 },
      history: [
        { text: "first prompt" },
        { text: "second command", promptMode: "shell" },
      ],
    });
    const rendered = await render(subject.element);

    await interact(rendered, () => rendered.mockInput.pressArrow("up"));
    expect(subject.handle().current.text).toBe("second command");
    expect(subject.handle().current.promptMode).toBe("shell");

    await interact(rendered, () => rendered.mockInput.pressArrow("up"));
    expect(subject.handle().current.text).toBe("first prompt");

    await interact(rendered, () => rendered.mockInput.pressArrow("down"));
    expect(subject.handle().current.text).toBe("first prompt");
    await interact(rendered, () => rendered.mockInput.pressArrow("down"));
    await interact(rendered, () => rendered.mockInput.pressArrow("down"));
    expect(subject.handle().current.text).toBe("working draft");
    expect(subject.handle().current.promptMode).toBe("normal");
  });

  test("normalizes bracketed paste, displays a placeholder, and expands on submit", async () => {
    const submissions: ComposerSubmission[] = [];
    const subject = harness({ onSubmit: (submission) => void submissions.push(submission) });
    const rendered = await render(subject.element);

    await interact(rendered, () => rendered.mockInput.pasteBracketedText("one\r\ntwo\rthree"));
    expect(subject.handle().current.text).toBe("[Pasted ~3 lines]");
    expect(subject.handle().current.pastePlaceholders).toHaveLength(1);

    await interact(rendered, () => rendered.mockInput.pressEnter());
    expect(submissions[0]?.displayText).toBe("[Pasted ~3 lines]");
    expect(submissions[0]?.expandedText).toBe("one\ntwo\nthree");
    expect(submissions[0]?.pastePlaceholders).toHaveLength(1);
    expect(subject.handle().current.text).toBe("[Pasted ~3 lines]");

    await interact(rendered, () => subject.handle().restorePastes());
    expect(subject.handle().current.text).toBe("one\ntwo\nthree");
  });

  test("renders busy, queued, waiting, and settling status labels", async () => {
    const draft = { text: "", revision: 0 };
    const noop = () => {};
    const rendered = await render(
      <box flexDirection="column">
        {(["busy", "queued", "waiting", "settling"] as const).map((status) => (
          <Composer
            key={status}
            sessionID={status}
            draft={draft}
            status={status}
            modelLabel="model"
            mode="build"
            workspaceLabel="workspace"
            commandCandidates={[]}
            fileCandidates={[]}
            historyEntries={[]}
            focused={false}
            onDraftChange={noop}
            onSubmit={noop}
            onModeChange={noop}
          />
        ))}
      </box>,
      40,
    );

    const frame = rendered.captureCharFrame();
    expect(frame).toContain("busy");
    expect(frame).toContain("queued");
    expect(frame).toContain("waiting");
    expect(frame).toContain("settling");
  });

  test("restores focus imperatively", async () => {
    const subject = harness();
    await render(subject.element);
    expect(subject.handle().focused).toBe(true);

    subject.handle().blur();
    expect(subject.handle().focused).toBe(false);
    subject.handle().restoreFocus();
    expect(subject.handle().focused).toBe(true);
  });
});
