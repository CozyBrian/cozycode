import { BrowserWindow, shell } from "electron";
import { auth, registry } from "@cozycode/core";
import type {
  CustomProviderInput,
  OAuthResult,
  OAuthStart,
  ProviderList,
} from "@cozycode/protocol";
import { IPC } from "../shared/ipc.ts";

export class ProviderBridge {
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

  async oauthStart(_providerID: string, _method: number): Promise<OAuthStart> {
    throw new Error("This provider does not offer OAuth sign-in.");
  }

  async oauthWait(_providerID: string): Promise<OAuthResult> {
    return { status: "failed", message: "No OAuth flow is pending." };
  }

  async oauthCancel(_providerID: string): Promise<void> {}

  open(url: string): Promise<void> {
    return shell.openExternal(url);
  }

  providerConfig(providerID: string) {
    return registry.providerConfig(providerID);
  }
}
