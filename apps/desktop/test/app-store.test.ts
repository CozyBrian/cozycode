import { beforeEach, describe, expect, test } from "bun:test";
import type { ProviderList } from "@cozycode/protocol";
import type { AppSettings, CozyApi, SessionMeta, SessionSnapshot } from "../src/shared/ipc.ts";
import { useApp } from "../src/renderer/src/store/app-store.ts";

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
  return { meta: session(id, workspaceRoot), records: [] };
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
    items: [],
    busy: false,
    model: null,
    effort: undefined,
    sessionHistory: [],
    sessionHistoryIndex: -1,
    subagentView: null,
    subagentHistory: [null],
    subagentHistoryIndex: 0,
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
