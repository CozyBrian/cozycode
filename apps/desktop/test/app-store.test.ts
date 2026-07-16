import { beforeEach, describe, expect, test } from "bun:test";
import type { ProviderList } from "@cozycode/protocol";
import type { AppSettings, CozyApi, SessionMeta, SessionSnapshot } from "../src/shared/ipc.ts";
import { isSessionRunningInBackground, newChatWorkspace, useApp } from "../src/renderer/src/store/app-store.ts";

const providers: ProviderList = { all: [], connected: ["test"] };
const continueSettings: AppSettings = { startupView: "continue-last-session" };

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
        getSettings: async () => continueSettings,
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
    backgroundComplete: false,
    preset: "ask",
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
    editingUserTurn: null,
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
    expect(useApp.getState().sessionViews.a?.backgroundComplete).toBe(true);
    expect(useApp.getState().sessionViews.b?.busy).toBe(true);
    expect(useApp.getState().busy).toBe(true);

    await useApp.getState().activateSession("a");
    expect(useApp.getState().sessionViews.a?.backgroundComplete).toBe(false);
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
    let activated = false;
    installApi({
      getSettings: async () => null,
      listSessions: async () => [session("existing")],
      activateSession: async () => {
        activated = true;
        return snapshot("existing");
      },
    });

    await useApp.getState().bootstrap();

    expect(useApp.getState()).toMatchObject({
      loaded: true,
      settings: null,
      settingsOpen: false,
      activeId: null,
      sessionHistory: [],
    });
    expect(activated).toBe(false);
  });

  test("continues the latest session when configured", async () => {
    installApi({
      getSettings: async () => continueSettings,
      listSessions: async () => [session("existing")],
    });

    await useApp.getState().bootstrap();

    expect(useApp.getState()).toMatchObject({
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

  test("shows the empty view after connecting the first provider", async () => {
    let created = false;
    installApi({
      getSettings: async () => null,
      providers: { list: async () => providers },
      createSession: async () => {
        created = true;
        return snapshot("first-provider-session");
      },
    });
    useApp.setState({ loaded: true, settingsOpen: true, providers: { all: [], connected: [] } });

    await useApp.getState().applyProviders(providers);

    expect(useApp.getState()).toMatchObject({
      activeId: null,
      settingsOpen: false,
      providers,
    });
    expect(created).toBe(false);
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
      providers,
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

  test("uses the last toggled project before the default workspace", () => {
    expect(newChatWorkspace({
      settings: {
        workspaceRoot: "/projects/default",
        openWorkspaceRoots: ["/projects/default", "/projects/toggled"],
        lastToggledWorkspaceRoot: "/projects/toggled",
      },
      sessions: [],
    })).toBe("/projects/toggled");
  });

  test("creates a standalone session explicitly", async () => {
    let requested: { workspaceRoot?: string | null } | undefined;
    installApi({
      createSession: async (opts) => {
        requested = opts;
        return snapshot("standalone");
      },
    });
    useApp.setState({ settings: { workspaceRoot: "/projects/default" }, providers });

    await useApp.getState().createSession(null);

    expect(requested).toEqual({ workspaceRoot: null });
    expect(useApp.getState().activeId).toBe("standalone");
  });

  test("creates a targeted session before sending from the empty view", async () => {
    let sent: { sessionId: string; message: string } | undefined;
    installApi({
      createSession: async (opts) => snapshot("created", opts?.workspaceRoot ?? null),
      send: async (sessionId, message) => {
        sent = { sessionId, message };
        return { ok: true };
      },
    });
    useApp.setState({
      activeId: null,
      providers,
      settings: { workspaceRoot: "/projects/default" },
      sessions: [],
    });

    await useApp.getState().send("hello");

    expect(sent).toEqual({ sessionId: "created", message: "hello" });
  });

  test("applies empty-view model and mode choices before sending", async () => {
    const applied: string[] = [];
    installApi({
      createSession: async () => snapshot("created"),
      setModel: async () => {
        applied.push("model");
      },
      setPreset: async () => {
        applied.push("preset");
      },
      send: async () => {
        applied.push("send");
        return { ok: true };
      },
    });
    useApp.setState({
      activeId: null,
      providers,
      model: { providerID: "test", modelID: "chosen" },
      preset: "plan",
      sessions: [],
    });

    await useApp.getState().send("hello");

    expect(applied).toEqual(["model", "preset", "send"]);
  });

  test("keeps an empty-view draft in its created session when navigation changes", async () => {
    let finishCreate!: (snapshot: SessionSnapshot) => void;
    const pendingCreate = new Promise<SessionSnapshot>((resolve) => {
      finishCreate = resolve;
    });
    let sentTo: string | null = null;
    installApi({
      createSession: async () => pendingCreate,
      activateSession: async (id) => snapshot(id),
      send: async (sessionId) => {
        sentTo = sessionId;
        return { ok: true };
      },
    });
    useApp.setState({
      activeId: null,
      providers,
      settings: { workspaceRoot: "/projects/new" },
      sessions: [session("other", "/projects/other")],
    });

    const send = useApp.getState().send("draft");
    await Bun.sleep(0);
    await useApp.getState().activateSession("other");
    finishCreate(snapshot("created"));
    await send;

    expect(sentTo).toBe("created");
    expect(useApp.getState().activeId).toBe("other");
    expect(useApp.getState().sessionViews.created).toBeDefined();
  });

  test("shows the empty view after deleting the active session", async () => {
    installApi({
      listSessions: async () => [session("active")],
      deleteSession: async () => null,
    });
    await useApp.getState().bootstrap();

    await useApp.getState().deleteSession("active");

    expect(useApp.getState()).toMatchObject({
      activeId: null,
      items: [],
      sessionHistory: [],
    });
  });

  test("does not clear a session activated while deletion is pending", async () => {
    let finishDelete!: () => void;
    const pendingDelete = new Promise<void>((resolve) => {
      finishDelete = resolve;
    });
    installApi({
      deleteSession: async () => {
        await pendingDelete;
        return null;
      },
      activateSession: async (id) => snapshot(id),
      listSessions: async () => [session("next")],
    });
    useApp.setState({
      activeId: "deleted",
      providers,
      sessions: [session("deleted"), session("next")],
      sessionHistory: ["deleted"],
      sessionHistoryIndex: 0,
    });

    const deletion = useApp.getState().deleteSession("deleted");
    await Bun.sleep(0);
    await useApp.getState().activateSession("next");
    finishDelete();
    await deletion;

    expect(useApp.getState().activeId).toBe("next");
    expect(useApp.getState().sessionHistory).not.toContain("deleted");
    expect(useApp.getState().sessionViews.deleted).toBeUndefined();
  });

  test("forks from before a user turn and prefills its text", async () => {
    installApi({
      forkFromTurn: async () => snapshot("fork", "/project"),
      listSessions: async () => [session("fork", "/project")],
    });
    useApp.setState({ activeId: "source", providers });

    await useApp.getState().forkFromTurn("turn-2", "try another way");

    expect(useApp.getState()).toMatchObject({
      activeId: "fork",
      input: "try another way",
    });
  });

  test("does not activate a fork that finishes after newer navigation", async () => {
    let finishFork!: (snapshot: SessionSnapshot) => void;
    const pendingFork = new Promise<SessionSnapshot>((resolve) => {
      finishFork = resolve;
    });
    installApi({
      forkSession: async () => pendingFork,
      activateSession: async (id) => snapshot(id),
      listSessions: async () => [session("other"), session("fork")],
    });
    useApp.setState({
      activeId: "source",
      providers,
      sessions: [session("source"), session("other")],
    });

    const fork = useApp.getState().forkSession("source");
    await Bun.sleep(0);
    await useApp.getState().activateSession("other");
    finishFork(snapshot("fork"));
    await fork;

    expect(useApp.getState().activeId).toBe("other");
    expect(useApp.getState().sessionViews.fork).toBeDefined();
  });

  test("optimistically truncates a session when editing a user turn", async () => {
    installApi({
      editTurn: async () => ({ ok: true }),
      listSessions: async () => [session("source")],
    });
    const view = useApp.getState().sessionViews.source;
    useApp.setState({
      activeId: "source",
      providers,
      items: [
        { id: "turn:one", kind: "user", text: "one", turnId: "one" },
        { id: "assistant:one", kind: "assistant", text: "answer one", streaming: false },
        { id: "turn:two", kind: "user", text: "two", turnId: "two" },
        { id: "assistant:two", kind: "assistant", text: "answer two", streaming: false },
      ],
      input: "unrelated draft",
      editingUserTurn: { sessionId: "source", turnId: "two", text: "two" },
      sessionViews: view ? { source: view } : {},
    });

    const edited = await useApp.getState().editUserTurn("two", "changed");

    expect(edited).toBe(true);
    expect(useApp.getState().items.map((item) => item.kind === "user" ? item.text : item.kind)).toEqual([
      "one",
      "assistant",
      "changed",
    ]);
    expect(useApp.getState().running).toBe(true);
    expect(useApp.getState().input).toBe("");
    expect(useApp.getState().editingUserTurn).toBeNull();
    useApp.getState().applyEvent({ sessionId: "source", event: { type: "session-settled" } });
    expect(useApp.getState().running).toBe(false);
  });

  test("keeps the normal draft when composer editing is cancelled", () => {
    useApp.setState({
      activeId: "source",
      input: "unrelated draft",
      editingUserTurn: { sessionId: "source", turnId: "one", text: "one" },
    });

    useApp.getState().setEditingUserTurn(null);

    expect(useApp.getState().input).toBe("unrelated draft");
    expect(useApp.getState().editingUserTurn).toBeNull();
  });

  test("preserves the normal draft and edit state when an edit fails", async () => {
    installApi({
      editTurn: async () => ({ ok: false, error: "failed" }),
      activateSession: async () => snapshot("source"),
      listSessions: async () => [session("source")],
    });
    useApp.setState({
      activeId: "source",
      providers,
      sessions: [session("source")],
      items: [{ id: "turn:one", kind: "user", text: "one", turnId: "one" }],
      input: "unrelated draft",
      editingUserTurn: { sessionId: "source", turnId: "one", text: "one" },
    });

    const edited = await useApp.getState().editUserTurn("one", "changed");

    expect(edited).toBe(false);
    expect(useApp.getState().input).toBe("unrelated draft");
    expect(useApp.getState().editingUserTurn).toEqual({
      sessionId: "source",
      turnId: "one",
      text: "one",
    });
  });

  test("cancels composer editing when navigating to another session", async () => {
    installApi({
      activateSession: async (id) => snapshot(id),
      listSessions: async () => [session("source"), session("other")],
    });
    useApp.setState({
      activeId: "source",
      providers,
      sessions: [session("source"), session("other")],
      editingUserTurn: { sessionId: "source", turnId: "one", text: "one" },
    });
    useApp.getState().setInput("unrelated draft");

    await useApp.getState().activateSession("other");

    expect(useApp.getState().editingUserTurn).toBeNull();
    expect(useApp.getState().sessionViews.source?.input).toBe("unrelated draft");
  });

  test("does not clear another session draft when an edit finishes after navigation", async () => {
    let finishEdit!: (result: { ok: boolean; error?: string }) => void;
    const pendingEdit = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      finishEdit = resolve;
    });
    installApi({
      editTurn: async () => pendingEdit,
      activateSession: async (id) => snapshot(id),
      listSessions: async () => [session("source"), session("other")],
    });
    useApp.setState({
      activeId: "source",
      providers,
      sessions: [session("source"), session("other")],
      items: [{ id: "turn:one", kind: "user", text: "one", turnId: "one" }],
      editingUserTurn: { sessionId: "source", turnId: "one", text: "one" },
    });
    useApp.getState().setInput("source draft");

    const edit = useApp.getState().editUserTurn("one", "changed");
    await Bun.sleep(0);
    await useApp.getState().activateSession("other");
    useApp.getState().setInput("other draft");
    finishEdit({ ok: true });
    await edit;

    expect(useApp.getState()).toMatchObject({
      activeId: "other",
      input: "other draft",
      editingUserTurn: null,
    });
    expect(useApp.getState().sessionViews.source?.input).toBe("");
  });

  test("does not restore a failed edit over newer navigation", async () => {
    let finishEdit!: (result: { ok: boolean; error?: string }) => void;
    const pendingEdit = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      finishEdit = resolve;
    });
    installApi({
      editTurn: async () => pendingEdit,
      activateSession: async (id) => snapshot(id),
      listSessions: async () => [session("source"), session("other")],
    });
    useApp.setState({
      activeId: "source",
      providers,
      sessions: [session("source"), session("other")],
      items: [{ id: "turn:one", kind: "user", text: "one", turnId: "one" }],
    });

    const edit = useApp.getState().editUserTurn("one", "changed");
    await Bun.sleep(0);
    await useApp.getState().activateSession("other");
    finishEdit({ ok: false, error: "failed" });
    await edit;

    expect(useApp.getState().activeId).toBe("other");
    expect(useApp.getState().sessionViews.source).toBeUndefined();
  });
});
