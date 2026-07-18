import { cycleEffort, effortsForModel } from "@cozycode/commands";
import type { DesktopCommandId } from "../../shared/desktop-commands.ts";
import { useApp } from "./store/app-store.ts";

export function executeDesktopCommand(command: DesktopCommandId): void {
  const state = useApp.getState();
  switch (command) {
    case "palette.open":
      if (state.permissionQueue.length || state.questionQueue.length) break;
      state.setCommandPalette(!state.commandPaletteOpen);
      break;
    case "chat.new":
      void state.createSession();
      break;
    case "chat.newStandalone":
      void state.createSession(null);
      break;
    case "project.open":
      void state.openWorkspace();
      break;
    case "terminal.new":
      void state.newTerminal();
      break;
    case "session.export":
      if (state.activeId) void state.exportSession(state.activeId);
      else state.systemNote("Open a session before exporting.", true);
      break;
    case "settings.open":
      state.openSettings();
      break;
    case "view.sidebar.toggle":
      state.toggleSidebar();
      break;
    case "view.terminal.toggle":
      state.toggleTerminal();
      break;
    case "view.contentPanel.toggle":
      state.toggleContentPanel();
      break;
    case "reasoning.effort.cycle": {
      const efforts = effortsForModel(state.providers ?? { all: [], connected: [] }, state.model);
      if (efforts.length) state.setEffort(cycleEffort(state.effort, efforts));
      break;
    }
    case "navigation.back":
      state.navigateBack();
      break;
    case "navigation.forward":
      state.navigateForward();
      break;
    case "help.open":
      state.setHelpOpen(true);
      break;
  }
}
