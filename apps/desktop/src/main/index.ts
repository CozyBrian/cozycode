import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join } from "node:path";
import type { ApprovalOutcome } from "@cozycode/protocol";
import { IPC, type AppSettingsInput } from "../shared/ipc.ts";
import { SettingsStore } from "./settings.ts";
import { SessionManager } from "./session-manager.ts";

const settings = new SettingsStore();
let manager: SessionManager | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    show: false,
    title: "cozycode",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });

  manager = new SessionManager(win.webContents, settings);

  win.on("ready-to-show", () => win.show());
  win.on("closed", () => {
    manager?.dispose();
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

  ipcMain.handle(IPC.sessionSend, (_e, message: string) => {
    if (!manager) return { ok: false, error: "No active window." };
    return manager.send(message);
  });
  ipcMain.handle(IPC.sessionAbort, () => manager?.abort());
  ipcMain.handle(IPC.sessionReset, () => manager?.reset());
  ipcMain.handle(
    IPC.approvalRespond,
    (_e, payload: { requestId: string; outcome: ApprovalOutcome }) =>
      manager?.resolveApproval(payload.requestId, payload.outcome),
  );
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
