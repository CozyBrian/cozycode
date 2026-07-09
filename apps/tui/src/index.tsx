#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./app.tsx";
import { resolveConfig } from "./config.ts";

async function main(): Promise<void> {
  let resolved;
  try {
    resolved = resolveConfig(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    backgroundColor: "#0a0a0a",
  });
  const root = createRoot(renderer);
  const exit = () => {
    root.unmount();
    renderer.destroy();
    process.exit(0);
  };

  root.render(
    <App
      initialSession={resolved.session}
      initialModel={resolved.initialModel}
      workspaceRoot={resolved.workspaceRoot}
      onExit={exit}
    />,
  );
}

void main();
