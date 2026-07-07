#!/usr/bin/env bun
import { render } from "ink";
import { App } from "./app.tsx";
import { resolveConfig } from "./config.ts";

function main(): void {
  let resolved;
  try {
    resolved = resolveConfig(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { waitUntilExit } = render(
    <App
      config={resolved.session}
      model={resolved.model}
      workspaceRoot={resolved.workspaceRoot}
    />,
  );

  void waitUntilExit();
}

main();
