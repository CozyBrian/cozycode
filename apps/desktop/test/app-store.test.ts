import { beforeEach, describe, expect, test } from "bun:test";
import type { ProviderList } from "@cozycode/protocol";
import type { AppSettings, CozyApi, SessionMeta, SessionSnapshot } from "../src/shared/ipc.ts";
import { isSessionRunningInBackground, useApp } from "../src/renderer/src/store/app-store.ts";

const providers: ProviderList = { all: [], connected: ["test"] };

function session(id: string, workspaceRoot: string | null = null): SessionMeta {
  return {
    id,
    title: id,
    titleEdited: false,
    createdAt: 1,
    updatedAt: 1,
    workspaceRoot,
    model: { providerID: "test", modelID: "model" },
    preset: "ask",
    messageCount: 0,
  };
}

function snapshot(id: string, workspaceRoot: string | null = null): SessionSnapshot {
  return {
    meta: session(id, workspaceRoot),
    records: [],
    running: false,
    permissionQueue: [],
    questionQueue: [],
  };
}

function installApi(overrides: Partial<CozyApi>): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      cozy: {
        getSettings: async () => null,
        providers: { list: async () => providers },
        listSessions: async () => [],
        createSession: async () => snapshot("new"),
        activateSession: async (id: string) => snapshot(id),
        ...overrides,
      },
    },
  });
}

beforeEach(() => {
  useApp.setState({
    settings: null,
    loaded: false,
    providers: null,
    recentModels: [],
    sessions: [],
    activeId: null,
    settingsOpen: false,
    settingsForwardAvailable: false,
    settingsSection: "general",
    contentPanelOpen: false,
    revision: 0,
    items: [],
    running: false,
    busy: false,
    model: null,
    effort: undefined,
    sessionHistory: [],
    sessionHistoryIndex: -1,
    subagentView: null,
    subagentHistory: [null],
    subagentHistoryIndex: 0,
    sessionViews: {},
    permissionQueue: [],
    questionQueue: [],
    input: "",
  });
});

describe("background sessions", () => {
  test("switches the visible session before activation I/O finishes", async () => {
    let finishActivation!: (snapshot: SessionSnapshot) => void;
    let finishSend!: (result: { ok: boolean }) => void;
    const pendingActivation = new Promise<SessionSnapshot>((resolve) => {
      finishActivation = resolve;
    });
    const pendingSend = new Promise<{ ok: boolean }>((resolve) => {
      finishSend = resolve;
    });
    installApi({
      listSessions: async () => [session("a"), session("b")],
      activateSession: async (id: string) => id === "b" ? pendingActivation : snapshot(id),
      send: async () => pendingSend,
    });
    await useApp.getState().bootstrap();

    const activation = useApp.getState().activateSession("b");
    expect(useApp.getState().activeId).toBe("b");
    const send = useApp.getState().send("new turn");
    useApp.getState().applyEvent({
      sessionId: "b",
      event: {
        type: "permission-asked",
        request: {
          id: "per_1",
          sessionId: "b",
          permission: "edit",
          patterns: ["file.ts"],
          metadata: {},
          always: [],
        },
      },
    });
    finishActivation(snapshot("b"));
    await activation;
    expect(useApp.getState().activeId).toBe("b");
    expect(useApp.getState().running).toBe(true);
    expect(useApp.getState().items[0]).toMatchObject({ kind: "user", text: "new turn" });
    expect(useApp.getState().permissionQueue).toHaveLength(1);
    finishSend({ ok: true });
    await send;
  });

  test("does not restore stale running state after a send settles during activation", async () => {
    let finishActivation!: (snapshot: SessionSnapshot) => void;
    let finishSend!: (result: { ok: boolean }) => void;
    const pendingActivation = new Promise<SessionSnapshot>((resolve) => {
      finishActivation = resolve;
    });
    const pendingSend = new Promise<{ ok: boolean }>((resolve) => {
      finishSend = resolve;
    });
    installApi({
      listSessions: async () => [session("a"), session("b")],
      activateSession: async (id: string) => id === "b" ? pendingActivation : snapshot(id),
      send: async () => pendingSend,
    });
    await useApp.getState().bootstrap();

    const activation = useApp.getState().activateSession("b");
    const send = useApp.getState().send("quick turn");
    finishSend({ ok: true });
    await send;
    finishActivation({ ...snapshot("b"), running: true });
    await activation;

    expect(useApp.getState().activeId).toBe("b");
    expect(useApp.getState().running).toBe(false);
  });

  test("routes events to an inactive running session and restores it on activation", async () => {
    let finishSend!: (result: { ok: boolean }) => void;
    const pendingSend = new Promise<{ ok: boolean }>((resolve) => {
      finishSend = resolve;
    });
    let aRunning = false;
    installApi({
      listSessions: async () => [session("a"), session("b")],
      activateSession: async (id: string) => ({
        ...snapshot(id),
        running: id === "a" && aRunning,
      }),
      send: async () => {
        aRunning = true;
        return pendingSend;
      },
    });

    await useApp.getState().bootstrap();
    const send = useApp.getState().send("hello");
    await Bun.sleep(0);
    await useApp.getState().activateSession("b");

    useApp.getState().applyEvent({ sessionId: "a", event: { type: "text-delta", text: "background" } });

    expect(useApp.getState().activeId).toBe("b");
    expect(useApp.getState().items).toEqual([]);
    expect(useApp.getState().sessionViews.a?.busy).toBe(true);
    expect(useApp.getState().sessionViews.a?.items.at(-1)).toMatchObject({
      kind: "assistant",
      text: "background",
    });
    expect(isSessionRunningInBackground(useApp.getState(), "a")).toBe(true);

    await useApp.getState().activateSession("a");
    expect(useApp.getState().busy).toBe(true);
    expect(useApp.getState().items.at(-1)).toMatchObject({ text: "background" });
    expect(isSessionRunningInBackground(useApp.getState(), "a")).toBe(false);

    useApp.getState().applyEvent({ sessionId: "a", event: { type: "finish", reason: "stop" } });
    expect(useApp.getState().sessionViews.a?.running).toBe(true);
    finishSend({ ok: true });
    await send;
    expect(useApp.getState().sessionViews.a?.running).toBe(false);
    expect(useApp.getState().sessionViews.a?.busy).toBe(false);
  });

  test("finishing one background session does not clear another session", async () => {
    installApi({ listSessions: async () => [session("a")] });
    await useApp.getState().bootstrap();
    const a = useApp.getState().sessionViews.a!;
    useApp.setState({
      activeId: "b",
      busy: true,
      sessionViews: {
        a: { ...a, busy: true },
        b: { ...a, busy: true },
      },
    });

    useApp.getState().applyEvent({ sessionId: "a", event: { type: "finish", reason: "stop" } });

    expect(useApp.getState().sessionViews.a?.busy).toBe(false);
    expect(useApp.getState().sessionViews.b?.busy).toBe(true);
    expect(useApp.getState().busy).toBe(true);
  });

  test("replies to the session that owns a rendered permission", async () => {
    let reply: Parameters<NonNullable<Partial<CozyApi>["replyPermission"]>>[0] | undefined;
    installApi({
      listSessions: async () => [session("a")],
      replyPermission: async (body) => {
        reply = body;
      },
    });
    await useApp.getState().bootstrap();
    const view = useApp.getState().sessionViews.a!;
    const request = {
      id: "per_1",
      sessionId: "a",
      permission: "edit",
      patterns: ["file.ts"],
      metadata: {},
      always: [],
    };
    useApp.setState({
      activeId: "b",
      sessionViews: {
        a: { ...view, permissionQueue: [request] },
        b: { ...view, permissionQueue: [{ ...request, sessionId: "b" }] },
      },
    });

    useApp.getState().replyPermission("per_1", "once", undefined, "a");

    expect(reply).toMatchObject({ sessionId: "a", requestId: "per_1", reply: "once" });
    expect(useApp.getState().sessionViews.a?.permissionQueue).toEqual([]);
    expect(useApp.getState().sessionViews.b?.permissionQueue).toHaveLength(1);
  });
});

describe("desktop bootstrap", () => {
  test("opens the main view with a connected provider and no default workspace", async () => {
    installApi({
      listSessions: async () => [session("existing")],
      activateSession: async () => snapshot("existing"),
    });

    await useApp.getState().bootstrap();

    expect(useApp.getState()).toMatchObject({
      loaded: true,
      settings: null,
      settingsOpen: false,
      activeId: "existing",
      sessionHistory: ["existing"],
    });
  });

  test("keeps Settings open when no provider is connected", async () => {
    installApi({ providers: { list: async () => ({ all: [], connected: [] }) } });

    await useApp.getState().bootstrap();

    expect(useApp.getState()).toMatchObject({
      loaded: true,
      settingsOpen: true,
      activeId: null,
      settingsSection: "providers",
    });
  });

  test("creates a main-view session after connecting the first provider", async () => {
    installApi({
      providers: { list: async () => providers },
      createSession: async () => snapshot("first-provider-session"),
    });
    useApp.setState({ loaded: true, settingsOpen: true, providers: { all: [], connected: [] } });

    await useApp.getState().applyProviders(providers);

    expect(useApp.getState()).toMatchObject({
      activeId: "first-provider-session",
      settingsOpen: false,
      providers,
    });
  });
});

describe("workspace and Settings navigation", () => {
  test("persists the first opened project when settings do not exist", async () => {
    let saved: AppSettings | null = null;
    installApi({
      pickWorkspace: async () => "/projects/cozycode",
      saveSettings: async (settings) => {
        saved = settings;
        return settings;
      },
    });

    await useApp.getState().openWorkspace();

    expect(saved).toMatchObject({
      workspaceRoot: "/projects/cozycode",
      openWorkspaceRoots: ["/projects/cozycode"],
    });
    expect(useApp.getState().settings).toEqual(saved);
  });

  test("traverses session history before restoring Settings with Forward", async () => {
    installApi({ activateSession: async (id: string) => snapshot(id) });
    useApp.setState({
      activeId: "second",
      settingsOpen: false,
      sessionHistory: ["first", "second"],
      sessionHistoryIndex: 1,
    });

    useApp.getState().openSettings();
    useApp.getState().navigateBack();
    expect(useApp.getState()).toMatchObject({
      settingsOpen: false,
      settingsForwardAvailable: true,
    });

    useApp.getState().navigateBack();
    await Bun.sleep(0);
    expect(useApp.getState()).toMatchObject({ activeId: "first", sessionHistoryIndex: 0 });

    useApp.getState().navigateForward();
    await Bun.sleep(0);
    expect(useApp.getState()).toMatchObject({
      activeId: "second",
      settingsOpen: false,
      sessionHistoryIndex: 1,
    });

    useApp.getState().navigateForward();
    expect(useApp.getState().settingsOpen).toBe(true);
  });
});
