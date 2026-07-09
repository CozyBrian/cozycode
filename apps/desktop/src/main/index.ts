import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join } from "node:path";
import type { AgentMode, PermissionReplyBody } from "@cozycode/protocol";
import { IPC, type AppSettingsInput, type PermissionPreset } from "../shared/ipc.ts";
import { SettingsStore } from "./settings.ts";
import { SessionManager } from "./session-manager.ts";

const settings = new SettingsStore();
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

  manager = new SessionManager(win.webContents, settings);

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
  ipcMain.handle(IPC.sessionSetModel, (_e, model: string) => manager?.setModel(model));
  ipcMain.handle(IPC.sessionSetPreset, (_e, preset: PermissionPreset) =>
    manager?.setPreset(preset),
  );
  ipcMain.handle(IPC.permissionReply, (_e, body: PermissionReplyBody) =>
    manager?.replyPermission(body),
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

  // models
  ipcMain.handle(IPC.modelsList, () => manager?.listModels() ?? []);

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
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
