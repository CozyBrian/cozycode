import {
  effortsForModel,
  resolveModelRef,
  type CommandContext,
} from "@cozycode/commands";
import { useApp } from "./store/app-store.ts";

export const DESKTOP_SLASH_COMMANDS = new Set([
  "new", "sessions", "fork", "delete", "export", "model", "effort",
  "provider", "plan", "build", "help", "quit",
]);

export function desktopCommandContext(): CommandContext {
  const current = () => useApp.getState();
  return {
    setMode: (mode) => current().setMode(mode),
    newSession: () => void current().createSession(),
    openSessionPicker: () => current().setCommandPalette(true, "sessions"),
    forkSession: () => {
      const state = current();
      if (state.activeId) void state.forkSession(state.activeId);
      else state.systemNote("Open a session before forking.", true);
    },
    deleteSession: () => {
      const state = current();
      if (state.activeId) void state.deleteSession(state.activeId);
      else state.systemNote("Open a session before deleting.", true);
    },
    exportSession: (path) => {
      const state = current();
      if (path) return state.systemNote("Desktop export uses the Save dialog and does not accept a path.", true);
      if (state.activeId) void state.exportSession(state.activeId);
      else state.systemNote("Open a session before exporting.", true);
    },
    openModelPicker: () => current().setModelPickerOpen(true),
    openProviderPicker: () => current().openSettings("providers"),
    setModel: (id) => {
      const state = current();
      if (!state.providers) return state.systemNote("Provider data is not loaded.", true);
      const result = resolveModelRef(id, state.providers);
      if ("error" in result) state.systemNote(result.error, true);
      else state.setModel(result);
    },
    setEffort: (level) => {
      const state = current();
      const efforts = effortsForModel(state.providers ?? { all: [], connected: [] }, state.model);
      if (!efforts.length) return state.systemNote("This model has no reasoning-effort control.", true);
      const normalized = level.toLowerCase();
      if (!normalized || normalized === "default") return state.setEffort(undefined);
      if (!efforts.includes(normalized)) {
        return state.systemNote(`Unknown effort "${level}". Available: ${efforts.join(", ")}.`, true);
      }
      state.setEffort(normalized);
    },
    openEffortPicker: () => {
      const state = current();
      const efforts = effortsForModel(state.providers ?? { all: [], connected: [] }, state.model);
      if (!efforts.length) return state.systemNote("This model has no reasoning-effort control.", true);
      state.setEffortPickerOpen(true);
    },
    showHelp: () => current().setHelpOpen(true),
    exit: () => void window.cozy.quit(),
    send: (text) => void current().send(text),
    notify: (kind, text) => current().systemNote(text, kind === "error"),
  };
}
