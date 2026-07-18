import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { DialogSelect } from "../src/components/DialogSelect.tsx";
import {
  AppShell,
  HomeView,
  RevertBar,
  SessionHeader,
  SessionListDialog,
  SessionSidebar,
  ShellHelp,
  WhichKey,
  type ShellSessionItem,
} from "../src/components/shell/index.ts";
import { theme } from "../src/theme.ts";

const renderers = new Set<TestRendererSetup>();
const actWarnings: string[] = [];
let originalConsoleError: typeof console.error;

beforeEach(() => {
  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (message.includes("not wrapped in act")) actWarnings.push(message);
    originalConsoleError(...args);
  };
});

afterEach(() => {
  for (const rendered of renderers) rendered.renderer.destroy();
  renderers.clear();
  console.error = originalConsoleError;
  setActEnvironment(true);
  expect(actWarnings.splice(0)).toEqual([]);
});

const sessions: readonly ShellSessionItem[] = [
  {
    id: "active",
    title: "Polish the TUI shell",
    workspace: "/work/cozycode",
    modelLabel: "claude-sonnet-4",
    mode: "build",
    status: "running",
    unread: null,
    updatedAt: 300,
    turnCount: 8,
  },
  {
    id: "worker",
    title: "Background test worker",
    workspace: "/work/cozycode/apps/tui",
    modelLabel: "gpt-5.6-sol",
    mode: "plan",
    status: "idle",
    unread: "completion",
    updatedAt: 200,
    turnCount: 3,
  },
  {
    id: "error",
    title: "Investigate archive failure",
    workspace: null,
    modelLabel: "deepseek-v4-flash",
    mode: "build",
    status: "error",
    unread: "error",
    updatedAt: 100,
    turnCount: 1,
  },
];

const usage = {
  turn: { inputTokens: 12_400, outputTokens: 820, totalTokens: 13_220 },
  total: { inputTokens: 18_400, outputTokens: 2_100, totalTokens: 20_500 },
};

function Sidebar({ onSelect = () => {} }: { onSelect?: (sessionID: string) => void }) {
  return (
    <SessionSidebar
      title="Polish the TUI shell"
      workspace="/work/cozycode"
      modelLabel="claude-sonnet-4"
      mode="build"
      effort="high"
      usage={usage}
      contextWindow={128_000}
      sessions={sessions}
      currentSessionID="active"
      keyboardEnabled
      onSelectSession={onSelect}
    />
  );
}

function ComposerSlot() {
  return (
    <box borderStyle="rounded" borderColor={theme.borderActive} paddingX={1}>
      <text fg={theme.muted}>Ask CozyCode anything</text>
    </box>
  );
}

async function render(element: React.ReactNode, width: number, height = 22) {
  setActEnvironment(true);
  const rendered = await testRender(element, { width, height, kittyKeyboard: true });
  renderers.add(rendered);
  await act(async () => {
    await rendered.flush();
  });
  setActEnvironment(false);
  return rendered;
}

async function interact(rendered: TestRendererSetup, callback: () => void | Promise<void>) {
  await callback();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await rendered.flush();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await rendered.flush();
}

function visibleFrame(rendered: TestRendererSetup): string {
  const lines = rendered.captureCharFrame().split("\n").map((line) => line.trimEnd());
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function expectHomeGolden(width: number, frame: string) {
  if (width === 80) expect(frame).toMatchInlineSnapshot(`
    "                         ▄▀▀ ▄▀▄ ▄▀▀ ▀▄ ▄ ▄▀▀ ▄▀▄ ▄▀▄ █▀
                             █▄▄ ▀▄▀ ▄██ ▄▀ █ ▀▄▄ ▀▄▀ █▄█ █▄

                                         cozycode


      ╭──────────────────────────────────────────────────────────────────────────╮
      │ Ask CozyCode anything                                                    │
      ╰──────────────────────────────────────────────────────────────────────────╯

                            ctrl+x then ? for keyboard help"
  `);
  else if (width === 120) expect(frame).toMatchInlineSnapshot(`
    "                                             ▄▀▀ ▄▀▄ ▄▀▀ ▀▄ ▄ ▄▀▀ ▄▀▄ ▄▀▄ █▀
                                                 █▄▄ ▀▄▀ ▄██ ▄▀ █ ▀▄▄ ▀▄▀ █▄█ █▄

                                                             cozycode


                          ╭──────────────────────────────────────────────────────────────────────────╮
                          │ Ask CozyCode anything                                                    │
                          ╰──────────────────────────────────────────────────────────────────────────╯

                                                ctrl+x then ? for keyboard help"
  `);
  else expect(frame).toMatchInlineSnapshot(`
    "                                             ▄▀▀ ▄▀▄ ▄▀▀ ▀▄ ▄ ▄▀▀ ▄▀▄ ▄▀▄ █▀
                                                 █▄▄ ▀▄▀ ▄██ ▄▀ █ ▀▄▄ ▀▄▀ █▄█ █▄

                                                             cozycode


                           ╭──────────────────────────────────────────────────────────────────────────╮
                           │ Ask CozyCode anything                                                    │
                           ╰──────────────────────────────────────────────────────────────────────────╯

                                                 ctrl+x then ? for keyboard help"
  `);
}

function expectActiveGolden(width: number, frame: string) {
  if (width === 80) expect(frame).toMatchInlineSnapshot(`
    "  Polish the TUI shell                                               ● running
      /work/cozycode                                                    2 children


      You
      Build the redesigned shell.











      ╭──────────────────────────────────────────────────────────────────────────╮
      │ Ask CozyCode anything                                                    │
      ╰──────────────────────────────────────────────────────────────────────────╯"
  `);
  else if (width === 120) expect(frame).toMatchInlineSnapshot(`
    "  Polish the TUI shell                                                                                       ● running
      /work/cozycode                                                                                            2 children


      You
      Build the redesigned shell.











      ╭──────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
      │ Ask CozyCode anything                                                                                            │
      ╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯"
  `);
  else expect(frame).toMatchInlineSnapshot(`
    "  Polish the TUI shell                                              ● running    Polish the TUI shell
      /work/cozycode                                                   2 children    /work/cozycode

                                                                                     Session
      You                                                                            claude-sonnet-4
      Build the redesigned shell.                                                    BUILD / high

                                                                                     Context
                                                                                     12k → 820 · 10%
                                                                                     21k total tokens

                                                                                     Sessions
                                                                                     > Polish the TUI shell      ● running
                                                                                       Background test worker     ● unread
                                                                                       Investigate archive failure × error


      ╭─────────────────────────────────────────────────────────────────────────╮
      │ Ask CozyCode anything                                                   │
      ╰─────────────────────────────────────────────────────────────────────────╯    ctrl+x l all sessions"
  `);
}

function expectSidebarGolden(width: number, frame: string) {
  if (width === 80) expect(frame).toMatchInlineSnapshot(`
    "  MAIN SESSION SURFACE                  Polish the TUI shell
                                            /work/cozycode

                                            Session
                                            claude-sonnet-4
                                            BUILD / high

                                            Context
                                            12k → 820 · 10%
                                            21k total tokens

                                            Sessions
                                            > Polish the TUI shell      ● running
                                              Background test worker     ● unread
                                              Investigate archive failure × error




                                            ctrl+x l all sessions"
  `);
  else if (width === 120) expect(frame).toMatchInlineSnapshot(`
    "  MAIN SESSION SURFACE                                                          Polish the TUI shell
                                                                                    /work/cozycode

                                                                                    Session
                                                                                    claude-sonnet-4
                                                                                    BUILD / high

                                                                                    Context
                                                                                    12k → 820 · 10%
                                                                                    21k total tokens

                                                                                    Sessions
                                                                                    > Polish the TUI shell      ● running
                                                                                      Background test worker     ● unread
                                                                                      Investigate archive failure × error




                                                                                    ctrl+x l all sessions"
  `);
  else expect(frame).toMatchInlineSnapshot(`
    "  MAIN SESSION SURFACE                                                           Polish the TUI shell
                                                                                     /work/cozycode

                                                                                     Session
                                                                                     claude-sonnet-4
                                                                                     BUILD / high

                                                                                     Context
                                                                                     12k → 820 · 10%
                                                                                     21k total tokens

                                                                                     Sessions
                                                                                     > Polish the TUI shell      ● running
                                                                                       Background test worker     ● unread
                                                                                       Investigate archive failure × error




                                                                                     ctrl+x l all sessions"
  `);
}

function expectDialogGolden(width: number, frame: string) {
  if (width === 80) expect(frame).toMatchInlineSnapshot(`
    "  SESSION TRANSCRIPT



      ╭──────────────────────────────────────────────────────────────────────────╮
      │                                                                          │
      │  Sessions                                                     esc close  │
      │                                                                          │
      │    worker                                                                │
      │                                                                          │
      │    Background test worker                                      ● unread  │
      │  gpt-5.6-sol  /  …/apps/tui  /  PLAN                                     │
      │                                                                          │
      │  rename ctrl+r  fork ctrl+f  delete ctrl+d                   1 sessions  │
      │                                                                          │
      ╰──────────────────────────────────────────────────────────────────────────╯"
  `);
  else if (width === 120) expect(frame).toMatchInlineSnapshot(`
    "  SESSION TRANSCRIPT



                         ╭────────────────────────────────────────────────────────────────────────────╮
                         │                                                                            │
                         │  Sessions                                                       esc close  │
                         │                                                                            │
                         │    worker                                                                  │
                         │                                                                            │
                         │    Background test worker                                        ● unread  │
                         │  gpt-5.6-sol  /  …/apps/tui  /  PLAN                                       │
                         │                                                                            │
                         │  rename ctrl+r  fork ctrl+f  delete ctrl+d                     1 sessions  │
                         │                                                                            │
                         ╰────────────────────────────────────────────────────────────────────────────╯"
  `);
  else expect(frame).toMatchInlineSnapshot(`
    "  SESSION TRANSCRIPT



                          ╭────────────────────────────────────────────────────────────────────────────╮
                          │                                                                            │
                          │  Sessions                                                       esc close  │
                          │                                                                            │
                          │    worker                                                                  │
                          │                                                                            │
                          │    Background test worker                                        ● unread  │
                          │  gpt-5.6-sol  /  …/apps/tui  /  PLAN                                       │
                          │                                                                            │
                          │  rename ctrl+r  fork ctrl+f  delete ctrl+d                     1 sessions  │
                          │                                                                            │
                          ╰────────────────────────────────────────────────────────────────────────────╯"
  `);
}

function expectRevertGolden(width: number, frame: string) {
  if (width === 80) expect(frame).toMatchInlineSnapshot(`
    "  Visible transcript















    │
    │  3 turns hidden                                         redo       commit
    │  Continue to replace the hidden future, or commit        ctrl+x r   ctrl+x c
    │  this point.
    │"
  `);
  else if (width === 120) expect(frame).toMatchInlineSnapshot(`
    "  Visible transcript
















    │
    │  3 turns hidden                                                                                 redo       commit
    │  Continue to replace the hidden future, or commit this point.                                    ctrl+x r   ctrl+x c
    │"
  `);
  else expect(frame).toMatchInlineSnapshot(`
    "  Visible transcript
















    │
    │  3 turns hidden                                                                                  redo       commit
    │  Continue to replace the hidden future, or commit this point.                                     ctrl+x r   ctrl+x c
    │"
  `);
}

for (const width of [80, 120, 121]) {
  describe(`shell goldens at ${width} columns`, () => {
    test("home", async () => {
      const rendered = await render(
        <AppShell>
          <HomeView composer={<ComposerSlot />} hint="ctrl+x then ? for keyboard help" />
        </AppShell>,
        width,
      );
      expectHomeGolden(width, visibleFrame(rendered));
    });

    test("active session", async () => {
      const rendered = await render(
        <AppShell sidebar={<Sidebar />}>
          <SessionHeader
            title="Polish the TUI shell"
            workspace="/work/cozycode"
            status="running"
            childCount={2}
          />
          <box flexGrow={1} paddingX={2} paddingTop={2}>
            <text fg={theme.primary}>You</text>
            <text fg={theme.text}>Build the redesigned shell.</text>
          </box>
          <box paddingX={2} paddingBottom={1}><ComposerSlot /></box>
        </AppShell>,
        width,
      );
      expectActiveGolden(width, visibleFrame(rendered));
    });

    test("sidebar overlay or inline with running and unread sessions", async () => {
      const rendered = await render(
        <AppShell sidebar={<Sidebar />} sidebarMode="open">
          <box paddingX={2} paddingTop={1}><text fg={theme.text}>MAIN SESSION SURFACE</text></box>
        </AppShell>,
        width,
      );
      expectSidebarGolden(width, visibleFrame(rendered));
    });

    test("dialog search", async () => {
      const rendered = await render(
        <AppShell
          overlay={(
            <SessionListDialog
              sessions={sessions}
              currentSessionID="active"
              initialQuery="worker"
              onSelect={() => {}}
              onCancel={() => {}}
              onRename={() => {}}
              onDelete={() => {}}
              onFork={() => {}}
            />
          )}
        >
          <box paddingX={2} paddingTop={1}><text fg={theme.text}>SESSION TRANSCRIPT</text></box>
        </AppShell>,
        width,
      );
      expectDialogGolden(width, visibleFrame(rendered));
    });

    test("revert bar", async () => {
      const rendered = await render(
        <AppShell>
          <box flexGrow={1} paddingX={2} paddingTop={1}><text fg={theme.text}>Visible transcript</text></box>
          <RevertBar hiddenTurnCount={3} />
        </AppShell>,
        width,
      );
      expectRevertGolden(width, visibleFrame(rendered));
    });
  });
}

describe("shell interactions", () => {
  test("initializes selects to the current item and supports keypad Enter and mouse", async () => {
    const selected: string[] = [];
    const rendered = await render(
      <DialogSelect
        title="Choose"
        options={[
          { value: "first", title: "First" },
          { value: "current", title: "Current", current: true },
        ]}
        onSelect={(value) => selected.push(value)}
        onCancel={() => {}}
      />,
      80,
    );

    await interact(rendered, () => rendered.mockInput.pressKeys(["\x1b[57414u"]));
    expect(selected).toEqual(["current"]);

    const first = rendered.renderer.root.findDescendantById("dialog-select-option-0");
    if (!first) throw new Error("First dialog option was not rendered");
    await interact(rendered, () => rendered.mockMouse.click(first.screenX + 1, first.screenY));
    expect(selected).toEqual(["current", "first"]);
  });

  test("allows the wide auto sidebar to be explicitly closed", async () => {
    const rendered = await render(
      <AppShell sidebar={<Sidebar />} sidebarMode="closed">
        <text>main only</text>
      </AppShell>,
      121,
    );
    expect(visibleFrame(rendered)).toBe("main only");
  });

  test("selects sidebar sessions with keyboard and mouse", async () => {
    const selected: string[] = [];
    const rendered = await render(
      <AppShell sidebar={<Sidebar onSelect={(sessionID) => selected.push(sessionID)} />} sidebarMode="open">
        <text>main</text>
      </AppShell>,
      80,
    );

    await interact(rendered, () => {
      rendered.mockInput.pressArrow("down");
      rendered.mockInput.pressEnter();
    });
    expect(selected).toEqual(["worker"]);

    const row = rendered.renderer.root.findDescendantById("shell-sidebar-session-error");
    if (!row) throw new Error("Error session row was not rendered");
    await interact(rendered, () => rendered.mockMouse.click(row.screenX + 2, row.screenY));
    expect(selected).toEqual(["worker", "error"]);
  });

  test("searches and runs dialog actions from keyboard and mouse", async () => {
    const selected: string[] = [];
    const forked: string[] = [];
    const rendered = await render(
      <SessionListDialog
        sessions={sessions}
        currentSessionID="active"
        onSelect={(sessionID) => selected.push(sessionID)}
        onCancel={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
        onFork={(sessionID) => forked.push(sessionID)}
      />,
      80,
    );

    await interact(rendered, () => rendered.mockInput.typeText("worker"));
    expect(visibleFrame(rendered)).toContain("Background test worker");
    expect(visibleFrame(rendered)).not.toContain("Polish the TUI shell");

    await interact(rendered, () => rendered.mockInput.pressKey("f", { ctrl: true }));
    expect(forked).toEqual(["worker"]);

    const row = rendered.renderer.root.findDescendantById("shell-dialog-session-worker");
    if (!row) throw new Error("Worker session row was not rendered");
    await interact(rendered, () => rendered.mockMouse.click(row.screenX + 2, row.screenY));
    expect(selected).toEqual(["worker"]);
  });

  test("invokes revert actions through the leader and mouse", async () => {
    const actions: string[] = [];
    const rendered = await render(
      <RevertBar
        hiddenTurnCount={2}
        onRedo={() => actions.push("redo")}
        onCommit={() => actions.push("commit")}
      />,
      80,
      6,
    );

    await interact(rendered, () => {
      rendered.mockInput.pressKey("x", { ctrl: true });
      rendered.mockInput.pressKey("r");
    });
    expect(actions).toEqual(["redo"]);

    const commit = rendered.renderer.root.findDescendantById("shell-revert-commit");
    if (!commit) throw new Error("Commit action was not rendered");
    await interact(rendered, () => rendered.mockMouse.click(commit.screenX + 1, commit.screenY));
    expect(actions).toEqual(["redo", "commit"]);
  });

  test("documents and previews the ctrl+x leader model", async () => {
    let closes = 0;
    const help = await render(<ShellHelp onClose={() => closes++} />, 80, 24);
    const helpFrame = visibleFrame(help);
    expect(helpFrame).toContain("ctrl+x leader");
    expect(helpFrame).toContain("ctrl+x l");
    expect(helpFrame).toContain("list sessions");
    await interact(help, () => help.mockInput.pressEnter());
    expect(closes).toBe(1);

    help.renderer.destroy();
    renderers.delete(help);

    const whichKey = await render(<WhichKey visible />, 80, 12);
    const whichKeyFrame = visibleFrame(whichKey);
    expect(whichKeyFrame).toContain("ctrl+x leader");
    expect(whichKeyFrame).toContain("toggle sidebar");
    expect(whichKeyFrame).toContain("b");
  });
});

function setActEnvironment(value: boolean) {
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  environment.IS_REACT_ACT_ENVIRONMENT = value;
}
