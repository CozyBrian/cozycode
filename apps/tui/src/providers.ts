import { spawn } from "node:child_process";
import { registry } from "@cozycode/core";
import type { ProviderList } from "@cozycode/protocol";

export function loadProviders(): Promise<ProviderList> {
  registry.invalidate();
  return registry.list();
}

export async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
