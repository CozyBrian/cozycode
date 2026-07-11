import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { auth, registry } from "@cozycode/core";
import { sessionMarkdownFilename } from "@cozycode/commands";
import type { AgentMode, CustomProviderInput, ModelRef, PermissionReplyBody, QuestionReplyBody } from "@cozycode/protocol";
import { IPC, type AppSettingsInput, type PermissionPreset } from "../shared/ipc.ts";
import { SettingsStore } from "./settings.ts";
import { SessionManager } from "./session-manager.ts";
import { ProviderBridge } from "./providers.ts";

const settings = new SettingsStore();
const providers = new ProviderBridge();
let manager: SessionManager | null = null;

const isMac = process.platform === "darwin";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    show: false,
    title: "cozycode",
    // On macOS: unified title bar with inset traffic lights + whole-window
    // vibrancy. `transparent: true` is intentionally avoided (it has known
    // focus/repaint bugs when combined with a title-bar style); a fully
    // transparent backgroundColor lets the vibrancy layer show through instead.
    ...(isMac
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 17 },
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
          backgroundColor: "#00000000",
        }
      : { backgroundColor: "#15171d" }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  manager = new SessionManager(win.webContents, settings, providers);

  win.on("ready-to-show", () => win.show());
  win.on("closed", () => {
    void manager?.dispose();
    manager = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.settingsGet, () => settings.getPublic());
  ipcMain.handle(IPC.settingsSave, (_e, input: AppSettingsInput) => settings.save(input));

  ipcMain.handle(IPC.pickWorkspace, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // active-session actions
  ipcMain.handle(IPC.sessionSend, (_e, message: string) => {
    if (!manager) return { ok: false, error: "No active window." };
    return manager.send(message);
  });
  ipcMain.handle(IPC.sessionAbort, () => manager?.abort());
  ipcMain.handle(IPC.sessionSetMode, (_e, mode: AgentMode) => manager?.setMode(mode));
  ipcMain.handle(IPC.sessionSetModel, (_e, model: ModelRef) => manager?.setModel(model));
  ipcMain.handle(IPC.sessionSetEffort, (_e, effort: string | null) =>
    manager?.setReasoningEffort(effort ?? undefined),
  );
  ipcMain.handle(IPC.sessionSetPreset, (_e, preset: PermissionPreset) =>
    manager?.setPreset(preset),
  );
  ipcMain.handle(IPC.permissionReply, (_e, body: PermissionReplyBody) =>
    manager?.replyPermission(body),
  );
  ipcMain.handle(IPC.questionReply, (_e, body: QuestionReplyBody) =>
    manager?.replyQuestion(body),
  );

  // session management
  ipcMain.handle(IPC.sessionsList, () => manager?.list() ?? []);
  ipcMain.handle(IPC.sessionsCreate, (_e, opts: { workspaceRoot?: string | null }) =>
    manager?.create(opts ?? {}),
  );
  ipcMain.handle(IPC.sessionsActivate, (_e, id: string) => manager?.activate(id));
  ipcMain.handle(IPC.sessionsDelete, (_e, id: string) => manager?.remove(id) ?? null);
  ipcMain.handle(IPC.sessionsRename, (_e, payload: { id: string; title: string }) =>
    manager?.rename(payload.id, payload.title),
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

  // providers
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
  ipcMain.handle(IPC.providersOauthWait, (_e, payload: { providerID: string; attemptID: string }) =>
    providers.oauthWait(payload.providerID, payload.attemptID),
  );
  ipcMain.handle(IPC.providersOauthCancel, (_e, payload: { providerID: string; attemptID: string }) =>
    providers.oauthCancel(payload.providerID, payload.attemptID),
  );
  ipcMain.handle(IPC.providersOpenExternal, (_e, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("Only HTTP links can be opened.");
    }
    return shell.openExternal(parsed.toString());
  });

  // terminal
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

  // git
  ipcMain.handle(IPC.gitStatus, () => manager?.git.status());
  ipcMain.handle(IPC.gitDiff, (_e, payload: { path: string; staged: boolean }) =>
    manager?.git.diff(payload.path, payload.staged),
  );
  ipcMain.handle(IPC.gitCommitDraft, () => manager?.generateCommitDraft());
  ipcMain.handle(IPC.gitCommit, (_e, draft) => manager?.commitGitDraft(draft));
  ipcMain.handle(IPC.gitPullRequestBases, () => manager?.pullRequestBases() ?? []);
  ipcMain.handle(IPC.gitPullRequestDraft, (_e, base: string) => manager?.generatePullRequestDraft(base));
}

app.whenReady().then(async () => {
  await settings.migrateProviderCredentials(registry, auth);
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
