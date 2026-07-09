import { BrowserWindow, shell } from "electron";
import { auth, oauth, registry, type OAuthFlow } from "@cozycode/core";
import type {
  CustomProviderInput,
  OAuthResult,
  OAuthStart,
  ProviderList,
} from "@cozycode/protocol";
import { IPC } from "../shared/ipc.ts";

export class ProviderBridge {
  private readonly pending = new Map<string, { providerID: string; flow: OAuthFlow }>();
  private readonly active = new Map<string, string>();
  private readonly completed = new Map<string, OAuthResult>();
  private readonly startQueues = new Map<string, Promise<unknown>>();

  async list(): Promise<ProviderList> {
    return registry.list();
  }

  private async changed(): Promise<ProviderList> {
    registry.invalidate();
    const list = await registry.list();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.webContents.isDestroyed()) win.webContents.send(IPC.providersChanged, list);
    }
    return list;
  }

  async connectApi(providerID: string, key: string): Promise<ProviderList> {
    const provider = (await registry.list()).all.find((item) => item.id === providerID);
    if (!provider) throw new Error(`Unknown provider: ${providerID}`);
    if (!key.trim() && provider.source !== "custom") throw new Error("API key is required.");
    await registry.connect(providerID, key.trim() || undefined);
    return this.changed();
  }

  async addCustom(input: CustomProviderInput): Promise<ProviderList> {
    await registry.addCustom(input);
    return this.changed();
  }

  async disconnect(providerID: string): Promise<ProviderList> {
    await auth.remove(providerID);
    return this.changed();
  }

  async oauthStart(providerID: string, method: number): Promise<OAuthStart> {
    const previous = this.startQueues.get(providerID) ?? Promise.resolve();
    const start = previous.catch(() => {}).then(async () => {
      const activeID = this.active.get(providerID);
      if (activeID) {
        const previous = this.pending.get(activeID);
        if (previous) {
          previous.flow.cancel();
          this.completed.set(activeID, await previous.flow.promise);
          this.pending.delete(activeID);
        }
        this.active.delete(providerID);
      }
      const flow = await oauth.authorize(providerID, method);
      this.pending.set(flow.start.attemptID, { providerID, flow });
      this.active.set(providerID, flow.start.attemptID);
      if (flow.browser) await shell.openExternal(flow.start.url);
      return flow.start;
    });
    this.startQueues.set(providerID, start);
    try {
      return await start;
    } finally {
      if (this.startQueues.get(providerID) === start) this.startQueues.delete(providerID);
    }
  }

  async oauthWait(providerID: string, attemptID: string): Promise<OAuthResult> {
    const done = this.completed.get(attemptID);
    if (done) return done;
    const pending = this.pending.get(attemptID);
    if (!pending || pending.providerID !== providerID) {
      return { status: "failed", message: "No OAuth flow is pending." };
    }
    const result = await pending.flow.promise;
    if (this.pending.get(attemptID) !== pending) return result;
    this.pending.delete(attemptID);
    if (this.active.get(providerID) === attemptID) this.active.delete(providerID);
    this.completed.set(attemptID, result);
    if (result.status === "complete") await this.changed();
    return result;
  }

  async oauthCancel(providerID: string, attemptID: string): Promise<void> {
    const pending = this.pending.get(attemptID);
    if (pending?.providerID === providerID) pending.flow.cancel();
  }

  providerConfig(providerID: string) {
    return registry.providerConfig(providerID);
  }
}
