import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * The main and preload processes are bundled for Node (electron-vite marks
 * Node built-ins external automatically). We deliberately DO NOT externalize
 * our dependencies: `@cozycode/core` is TypeScript source and `ai`/`zod` are
 * pure JS, so bundling them produces a single runnable `out/main/index.js`.
 * The renderer is a normal React app and never imports the core directly — it
 * talks to it only over IPC.
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: { external: ["electron"] },
    },
  },
  preload: {
    build: {
      rollupOptions: { external: ["electron"] },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
