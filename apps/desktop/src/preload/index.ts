import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AgentMode,
  ApprovalOutcome,
  ApprovalRequest,
  SessionEvent,
} from "@cozycode/protocol";
import {
  IPC,
  type AppSettingsInput,
  type CozyApi,
  type PermissionPreset,
  type SessionMeta,
  type TermData,
  type TermExit,
} from "../shared/ipc.ts";

const api: CozyApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (input: AppSettingsInput) => ipcRenderer.invoke(IPC.settingsSave, input),
  pickWorkspace: () => ipcRenderer.invoke(IPC.pickWorkspace),

  send: (message: string) => ipcRenderer.invoke(IPC.sessionSend, message),
  abort: () => ipcRenderer.invoke(IPC.sessionAbort),
  setMode: (mode: AgentMode) => ipcRenderer.invoke(IPC.sessionSetMode, mode),
  setModel: (model: string) => ipcRenderer.invoke(IPC.sessionSetModel, model),
  setPreset: (preset: PermissionPreset) => ipcRenderer.invoke(IPC.sessionSetPreset, preset),
  respondApproval: (requestId: string, outcome: ApprovalOutcome) =>
    ipcRenderer.invoke(IPC.approvalRespond, { requestId, outcome }),

  listSessions: () => ipcRenderer.invoke(IPC.sessionsList),
  createSession: (opts) => ipcRenderer.invoke(IPC.sessionsCreate, opts ?? {}),
  activateSession: (id: string) => ipcRenderer.invoke(IPC.sessionsActivate, id),
  deleteSession: (id: string) => ipcRenderer.invoke(IPC.sessionsDelete, id),
  renameSession: (id: string, title: string) =>
    ipcRenderer.invoke(IPC.sessionsRename, { id, title }),

  listModels: () => ipcRenderer.invoke(IPC.modelsList),

  term: {
    create: (opts) => ipcRenderer.invoke(IPC.termCreate, opts),
    write: (termId: string, data: string) => ipcRenderer.invoke(IPC.termInput, { termId, data }),
    resize: (termId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(IPC.termResize, { termId, cols, rows }),
    kill: (termId: string) => ipcRenderer.invoke(IPC.termKill, termId),
    onData(cb: (payload: TermData) => void) {
      const listener = (_e: IpcRendererEvent, payload: TermData) => cb(payload);
      ipcRenderer.on(IPC.termData, listener);
      return () => ipcRenderer.off(IPC.termData, listener);
    },
    onExit(cb: (payload: TermExit) => void) {
      const listener = (_e: IpcRendererEvent, payload: TermExit) => cb(payload);
      ipcRenderer.on(IPC.termExit, listener);
      return () => ipcRenderer.off(IPC.termExit, listener);
    },
  },

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
  onSessionsChanged(cb: (sessions: SessionMeta[]) => void) {
    const listener = (_e: IpcRendererEvent, sessions: SessionMeta[]) => cb(sessions);
    ipcRenderer.on(IPC.sessionsChanged, listener);
    return () => ipcRenderer.off(IPC.sessionsChanged, listener);
  },
};

contextBridge.exposeInMainWorld("cozy", api);
