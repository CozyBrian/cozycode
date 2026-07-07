import type {
  ApprovalOutcome,
  ApprovalRequest,
  PermissionPolicy,
  SessionEvent,
} from "@cozycode/protocol";

/** Persisted app settings. The API key is stored separately (encrypted). */
export interface AppSettings {
  providerName: string;
  baseURL: string;
  model: string;
  workspaceRoot: string;
  /** Optional override; falls back to the core default policy when absent. */
  permissions?: PermissionPolicy;
  /** True when an API key is stored (the key itself is never sent to the UI). */
  hasApiKey: boolean;
}

/** Settings payload the renderer sends when saving (may include a new key). */
export interface AppSettingsInput extends Omit<AppSettings, "hasApiKey"> {
  apiKey?: string;
}

/** IPC channel names, centralized so main/preload/renderer agree. */
export const IPC = {
  settingsGet: "settings:get",
  settingsSave: "settings:save",
  pickWorkspace: "dialog:pick-workspace",
  sessionSend: "session:send",
  sessionAbort: "session:abort",
  sessionReset: "session:reset",
  approvalRespond: "approval:respond",
  // main -> renderer (push)
  sessionEvent: "session:event",
  approvalRequest: "approval:request",
} as const;

/** The typed API exposed on `window.cozy` by the preload script. */
export interface CozyApi {
  getSettings(): Promise<AppSettings | null>;
  saveSettings(input: AppSettingsInput): Promise<AppSettings>;
  pickWorkspace(): Promise<string | null>;
  send(message: string): Promise<{ ok: boolean; error?: string }>;
  abort(): Promise<void>;
  reset(): Promise<void>;
  respondApproval(requestId: string, outcome: ApprovalOutcome): Promise<void>;
  onEvent(cb: (event: SessionEvent) => void): () => void;
  onApprovalRequest(cb: (request: ApprovalRequest) => void): () => void;
}

declare global {
  interface Window {
    cozy: CozyApi;
  }
}
