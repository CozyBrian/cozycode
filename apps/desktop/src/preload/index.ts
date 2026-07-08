import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { AgentMode, ApprovalOutcome, ApprovalRequest, SessionEvent } from "@cozycode/protocol";
import { IPC, type AppSettingsInput, type CozyApi } from "../shared/ipc.ts";

const api: CozyApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (input: AppSettingsInput) => ipcRenderer.invoke(IPC.settingsSave, input),
  pickWorkspace: () => ipcRenderer.invoke(IPC.pickWorkspace),
  send: (message: string) => ipcRenderer.invoke(IPC.sessionSend, message),
  abort: () => ipcRenderer.invoke(IPC.sessionAbort),
  reset: () => ipcRenderer.invoke(IPC.sessionReset),
  setMode: (mode: AgentMode) => ipcRenderer.invoke(IPC.sessionSetMode, mode),
  respondApproval: (requestId: string, outcome: ApprovalOutcome) =>
    ipcRenderer.invoke(IPC.approvalRespond, { requestId, outcome }),

  onEvent(cb: (event: SessionEvent) => void) {
    const listener = (_e: IpcRendererEvent, event: SessionEvent) => cb(event);
    ipcRenderer.on(IPC.sessionEvent, listener);
    return () => ipcRenderer.off(IPC.sessionEvent, listener);
  },
  onApprovalRequest(cb: (request: ApprovalRequest) => void) {
    const listener = (_e: IpcRendererEvent, request: ApprovalRequest) => cb(request);
    ipcRenderer.on(IPC.approvalRequest, listener);
    return () => ipcRenderer.off(IPC.approvalRequest, listener);
  },
};

contextBridge.exposeInMainWorld("cozy", api);
