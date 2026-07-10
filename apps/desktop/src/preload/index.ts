import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  AgentMode,
  CustomProviderInput,
  ModelRef,
  PermissionReplyBody,
  ProviderList,
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
  setModel: (ref: ModelRef) => ipcRenderer.invoke(IPC.sessionSetModel, ref),
  setEffort: (effort?: string) => ipcRenderer.invoke(IPC.sessionSetEffort, effort ?? null),
  setPreset: (preset: PermissionPreset) => ipcRenderer.invoke(IPC.sessionSetPreset, preset),
  replyPermission: (body: PermissionReplyBody) => ipcRenderer.invoke(IPC.permissionReply, body),

  listSessions: () => ipcRenderer.invoke(IPC.sessionsList),
  createSession: (opts) => ipcRenderer.invoke(IPC.sessionsCreate, opts ?? {}),
  activateSession: (id: string) => ipcRenderer.invoke(IPC.sessionsActivate, id),
  deleteSession: (id: string) => ipcRenderer.invoke(IPC.sessionsDelete, id),
  renameSession: (id: string, title: string) =>
    ipcRenderer.invoke(IPC.sessionsRename, { id, title }),

  providers: {
    list: () => ipcRenderer.invoke(IPC.providersList),
    connectApi: (providerID: string, apiKey: string) =>
      ipcRenderer.invoke(IPC.providersConnectApi, { providerID, apiKey }),
    addCustom: (input: CustomProviderInput) =>
      ipcRenderer.invoke(IPC.providersAddCustom, input),
    disconnect: (providerID: string) =>
      ipcRenderer.invoke(IPC.providersDisconnect, providerID),
    oauthStart: (providerID: string, method: number) =>
      ipcRenderer.invoke(IPC.providersOauthStart, { providerID, method }),
    oauthWait: (providerID: string, attemptID: string) =>
      ipcRenderer.invoke(IPC.providersOauthWait, { providerID, attemptID }),
    oauthCancel: (providerID: string, attemptID: string) =>
      ipcRenderer.invoke(IPC.providersOauthCancel, { providerID, attemptID }),
    openExternal: (url: string) => ipcRenderer.invoke(IPC.providersOpenExternal, url),
    onChanged(cb: (list: ProviderList) => void) {
      const listener = (_e: IpcRendererEvent, list: ProviderList) => cb(list);
      ipcRenderer.on(IPC.providersChanged, listener);
      return () => ipcRenderer.off(IPC.providersChanged, listener);
    },
  },

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
  onSessionsChanged(cb: (sessions: SessionMeta[]) => void) {
    const listener = (_e: IpcRendererEvent, sessions: SessionMeta[]) => cb(sessions);
    ipcRenderer.on(IPC.sessionsChanged, listener);
    return () => ipcRenderer.off(IPC.sessionsChanged, listener);
  },
};

contextBridge.exposeInMainWorld("cozy", api);
