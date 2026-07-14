import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/**
 * The main and preload processes are bundled for Node (electron-vite marks
 * Node built-ins external automatically). We deliberately DO NOT externalize
 * our dependencies: `@cozycode/core` is TypeScript source and `ai`/`zod` are
 * pure JS, so bundling them produces a single runnable `out/main/index.js`.
 * The renderer is a normal React app and never imports the core directly — it
 * talks to it only over IPC.
 *
 * `@lydell/node-pty` is the exception: it loads a native `.node` binary that
 * cannot be bundled, so it stays external and is resolved from node_modules at
 * runtime (its prebuilt binaries are N-API, so no per-Electron rebuild).
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: { external: ["electron", "@lydell/node-pty"] },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: ["electron"],
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
      },
    },
  },
});
