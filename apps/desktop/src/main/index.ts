import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions,
} from "electron";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auth, registry } from "@cozycode/core";
import { sessionMarkdownFilename } from "@cozycode/commands";
import type {
  AgentMode,
  CustomProviderInput,
  ModelRef,
} from "@cozycode/protocol";
import {
  IPC,
  type AppSettings,
  type AppSettingsInput,
  type AddressedPermissionReply,
  type AddressedQuestionReply,
  type EditTurnRequest,
  type NativeCommand,
  type PermissionPreset,
} from "../shared/ipc.ts";
import { DESKTOP_COMMANDS, resolveShortcut, toElectronAccelerator } from "../shared/desktop-commands.ts";
import { SettingsStore } from "./settings.ts";
import { SessionManager } from "./session-manager.ts";
import { ProviderBridge } from "./providers.ts";
import { loadWindowState, trackWindowState } from "./window-state.ts";

const isMac = process.platform === "darwin";
const developmentIcon = join(import.meta.dirname, "../../resources/icon.png");
const repositoryUrl = "https://github.com/CozyBrian/cozycode";

// Keep development attached to its existing archive. The packaged 0.1.0 app
// intentionally starts fresh under the canonical CozyCode userData directory.
if (!app.isPackaged) {
  app.setPath("userData", join(app.getPath("appData"), "@cozycode", "desktop"));
}

const settings = new SettingsStore();
const providers = new ProviderBridge();
const pendingNativeCommands: NativeCommand[] = [];
let mainWindow: BrowserWindow | null = null;
let manager: SessionManager | null = null;
let managerDisposal: Promise<void> = Promise.resolve();
let closingWindow = false;
let quitting = false;
let resolveStartup: () => void = () => undefined;
const startupReady = new Promise<void>((resolve) => {
  resolveStartup = resolve;
});

function flushNativeCommands(window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isLoadingMainFrame()) return;
  pendingNativeCommands.splice(0).forEach((command) => {
    window.webContents.send(IPC.nativeCommand, command);
  });
}

async function ensureWindow(): Promise<void> {
  await app.whenReady();
  await startupReady;
  if (closingWindow) await managerDisposal;
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  const window = mainWindow;
  if (!window) return;
  if (window.isMinimized()) window.restore();
  if (!window.webContents.isLoadingMainFrame()) window.show();
  window.focus();
  flushNativeCommands(window);
}

function sendNativeCommand(command: NativeCommand): void {
  pendingNativeCommands.push(command);
  void ensureWindow();
}

function installNativeMenus(currentSettings: AppSettings | null): void {
  const command = (value: NativeCommand) => () => sendNativeCommand(value);
  const accelerator = (id: NativeCommand) => {
    const definition = DESKTOP_COMMANDS.find((item) => item.id === id)!;
    return toElectronAccelerator(resolveShortcut(definition, currentSettings?.shortcutOverrides));
  };
  const template: MenuItemConstructorOptions[] = [
    {
      label: "CozyCode",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: accelerator("settings.open"),
          click: command("settings.open"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Chat", accelerator: accelerator("chat.new"), click: command("chat.new") },
        {
          label: "New Standalone Chat",
          accelerator: accelerator("chat.newStandalone"),
          click: command("chat.newStandalone"),
        },
        {
          label: "Open Project…",
          accelerator: accelerator("project.open"),
          click: command("project.open"),
        },
        {
          label: "New Terminal",
          accelerator: accelerator("terminal.new"),
          click: command("terminal.new"),
        },
        { type: "separator" },
        {
          label: "Export Current Session…",
          accelerator: accelerator("session.export"),
          click: command("session.export"),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: accelerator("view.sidebar.toggle"),
          click: command("view.sidebar.toggle"),
        },
        {
          label: "Toggle Terminal",
          accelerator: accelerator("view.terminal.toggle"),
          click: command("view.terminal.toggle"),
        },
        {
          label: "Toggle Content Panel",
          accelerator: accelerator("view.contentPanel.toggle"),
          click: command("view.contentPanel.toggle"),
        },
        {
          label: "Cycle Reasoning Effort",
          accelerator: accelerator("reasoning.effort.cycle"),
          click: command("reasoning.effort.cycle"),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(!app.isPackaged
          ? ([
              { type: "separator" },
              { role: "toggleDevTools" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: "Navigate",
      submenu: [
        { label: "Back", accelerator: accelerator("navigation.back"), click: command("navigation.back") },
        {
          label: "Forward",
          accelerator: accelerator("navigation.forward"),
          click: command("navigation.forward"),
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
    {
      role: "help",
      submenu: [
        { label: "Command Palette…", accelerator: accelerator("palette.open"), click: command("palette.open") },
        { label: "CozyCode Help", accelerator: accelerator("help.open"), click: command("help.open") },
        { type: "separator" },
        { label: "CozyCode on GitHub", click: () => void shell.openExternal(repositoryUrl) },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (isMac) {
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        { label: "New Chat", click: command("chat.new") },
        { label: "New Standalone Chat", click: command("chat.newStandalone") },
        { label: "Open Project…", click: command("project.open") },
        { label: "New Terminal", click: command("terminal.new") },
        { type: "separator" },
        { label: "Settings…", click: command("settings.open") },
      ]),
    );
  }
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) return;
  const savedState = loadWindowState();
  const window = new BrowserWindow({
    width: savedState?.width ?? 1100,
    height: savedState?.height ?? 780,
    ...(savedState ? { x: savedState.x, y: savedState.y } : {}),
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: "CozyCode",
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 17 },
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
          backgroundColor: "#00000000",
        }
      : { backgroundColor: "#15171d" }),
    ...(!app.isPackaged && existsSync(developmentIcon) ? { icon: developmentIcon } : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  const sessionManager = new SessionManager(window.webContents, settings, providers);
  const saveWindowState = trackWindowState(window);
  mainWindow = window;
  manager = sessionManager;

  window.once("ready-to-show", () => {
    if (savedState?.maximized && !savedState.fullscreen) window.maximize();
    window.show();
    if (savedState?.fullscreen) window.setFullScreen(true);
  });
  window.webContents.once("did-finish-load", () => flushNativeCommands(window));

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url === window.webContents.getURL()) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });

  window.on("close", (event) => {
    if (closingWindow) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    closingWindow = true;
    saveWindowState();
    window.hide();
    if (manager === sessionManager) manager = null;
    if (isMac) app.dock?.setBadge("");

    managerDisposal = sessionManager
      .dispose()
      .catch((error) => console.error("Failed to dispose session manager", error))
      .then(() => {
        if (!window.isDestroyed()) window.destroy();
      });
    void managerDisposal.then(() => {
      if (quitting) app.quit();
    });
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    closingWindow = false;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => settings.getPublic());
  ipcMain.handle(IPC.settingsSave, async (_e, input: AppSettingsInput) => {
    const saved = await settings.save(input);
    installNativeMenus(saved);
    return saved;
  });
  ipcMain.handle(IPC.appQuit, () => app.quit());

  ipcMain.handle(IPC.pickWorkspace, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(IPC.sessionSend, (_e, payload: { sessionId: string; message: string; turnId: string }) => {
    if (!manager) return { ok: false, error: "No active window." };
    return manager.send(payload.sessionId, payload.message, payload.turnId);
  });
  ipcMain.handle(IPC.sessionShell, (_e, payload: { sessionId: string; command: string; turnId: string }) => {
    if (!manager) return { ok: false, error: "No active window." };
    return manager.shell(payload.sessionId, payload.command, payload.turnId);
  });
  ipcMain.handle(IPC.sessionReferenceSearch, (_e, payload: { sessionId: string; query: string }) =>
    manager?.searchWorkspaceReferences(payload.sessionId, payload.query) ?? [],
  );
  ipcMain.handle(IPC.sessionAbort, (_e, sessionId: string) => manager?.abort(sessionId));
  ipcMain.handle(IPC.sessionSetMode, (_e, payload: { sessionId: string; mode: AgentMode }) => manager?.setMode(payload.sessionId, payload.mode));
  ipcMain.handle(IPC.sessionSetModel, (_e, payload: { sessionId: string; ref: ModelRef }) => manager?.setModel(payload.sessionId, payload.ref));
  ipcMain.handle(IPC.sessionSetEffort, (_e, payload: { sessionId: string; effort: string | null }) =>
    manager?.setReasoningEffort(payload.sessionId, payload.effort ?? undefined),
  );
  ipcMain.handle(IPC.sessionSetPreset, (_e, payload: { sessionId: string; preset: PermissionPreset }) =>
    manager?.setPreset(payload.sessionId, payload.preset),
  );
  ipcMain.handle(IPC.permissionReply, (_e, body: AddressedPermissionReply) =>
    manager?.replyPermission(body),
  );
  ipcMain.handle(IPC.questionReply, (_e, body: AddressedQuestionReply) =>
    manager?.replyQuestion(body),
  );

  ipcMain.handle(IPC.sessionsList, () => manager?.list() ?? []);
  ipcMain.handle(IPC.sessionsCreate, (_e, opts: { workspaceRoot?: string | null }) =>
    manager?.create(opts ?? {}),
  );
  ipcMain.handle(IPC.sessionsActivate, (_e, id: string) => manager?.activate(id));
  ipcMain.handle(IPC.sessionsDelete, (_e, id: string) => manager?.remove(id) ?? null);
  ipcMain.handle(IPC.sessionsRename, (_e, payload: { id: string; title: string }) =>
    manager?.rename(payload.id, payload.title),
  );
  ipcMain.handle(IPC.sessionsFork, (_e, id: string) => manager?.forkSession(id));
  ipcMain.handle(IPC.sessionsForkTurn, (_e, payload: { sessionId: string; turnId: string }) =>
    manager?.forkFromTurn(payload.sessionId, payload.turnId),
  );
  ipcMain.handle(IPC.sessionsEditTurn, (_e, request: EditTurnRequest) =>
    manager?.editTurn(request.sessionId, request.turnId, request.replacementTurnId, request.text),
  );
  ipcMain.handle(IPC.sessionsExport, async (_e, id: string) => {
    if (!manager) return null;
    const { title, markdown } = await manager.exportMarkdown(id);
    const result = await dialog.showSaveDialog({
      defaultPath: sessionMarkdownFilename(title),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, markdown, "utf8");
    return result.filePath;
  });

  ipcMain.handle(IPC.providersList, () => providers.list());
  ipcMain.handle(
    IPC.providersConnectApi,
    (_e, payload: { providerID: string; apiKey: string }) =>
      providers.connectApi(payload.providerID, payload.apiKey),
  );
  ipcMain.handle(IPC.providersAddCustom, (_e, input: CustomProviderInput) =>
    providers.addCustom(input),
  );
  ipcMain.handle(IPC.providersDisconnect, (_e, providerID: string) =>
    providers.disconnect(providerID),
  );
  ipcMain.handle(
    IPC.providersOauthStart,
    (_e, payload: { providerID: string; method: number }) =>
      providers.oauthStart(payload.providerID, payload.method),
  );
  ipcMain.handle(
    IPC.providersOauthWait,
    (_e, payload: { providerID: string; attemptID: string }) =>
      providers.oauthWait(payload.providerID, payload.attemptID),
  );
  ipcMain.handle(
    IPC.providersOauthCancel,
    (_e, payload: { providerID: string; attemptID: string }) =>
      providers.oauthCancel(payload.providerID, payload.attemptID),
  );
  ipcMain.handle(IPC.providersOpenExternal, (_e, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Only HTTP links can be opened.");
    }
    return shell.openExternal(parsed.toString());
  });

  ipcMain.handle(IPC.termCreate, (_e, opts: { cols: number; rows: number }) =>
    manager?.terminals.create(opts),
  );
  ipcMain.handle(IPC.termInput, (_e, payload: { termId: string; data: string }) =>
    manager?.terminals.write(payload.termId, payload.data),
  );
  ipcMain.handle(
    IPC.termResize,
    (_e, payload: { termId: string; cols: number; rows: number }) =>
      manager?.terminals.resize(payload.termId, payload.cols, payload.rows),
  );
  ipcMain.handle(IPC.termKill, (_e, termId: string) => manager?.terminals.kill(termId));

  ipcMain.handle(IPC.gitStatus, () => manager?.git.status());
  ipcMain.handle(IPC.gitDiff, (_e, payload: { path: string; staged: boolean }) =>
    manager?.git.diff(payload.path, payload.staged),
  );

  ipcMain.on(IPC.dockBadge, (_event, value: unknown) => {
    if (!isMac || !Number.isInteger(value) || (value as number) < 0 || (value as number) > 9999)
      return;
    const count = value as number;
    app.dock?.setBadge(count ? (count > 99 ? "99+" : String(count)) : "");
  });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => void ensureWindow());
  app.on("before-quit", () => {
    quitting = true;
  });

  void app.whenReady().then(async () => {
    await settings
      .migrateProviderCredentials(registry, auth)
      .catch((error) => console.error("Provider credential migration failed", error));
    registerIpc();
    installNativeMenus(await settings.getPublic());
    app.setAboutPanelOptions({
      applicationName: "CozyCode",
      applicationVersion: app.getVersion(),
      version: `Version ${app.getVersion()}`,
      copyright: "Personal software by CozyBrian.",
      website: repositoryUrl,
    });
    if (isMac && !app.isPackaged && existsSync(developmentIcon)) {
      app.dock?.setIcon(developmentIcon);
    }
    createWindow();
    resolveStartup();
    app.on("activate", () => void ensureWindow());
  });
}

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});
