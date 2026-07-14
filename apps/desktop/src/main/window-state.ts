import { app, screen, type BrowserWindow, type Rectangle } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WindowState extends Rectangle {
  maximized: boolean;
  fullscreen: boolean;
}

function stateFile(): string {
  return join(app.getPath("userData"), "window-state.json");
}

export function loadWindowState(): WindowState | null {
  try {
    const value = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<WindowState>;
    if (
      ![value.x, value.y, value.width, value.height].every(Number.isFinite) ||
      !value.width ||
      !value.height ||
      value.width < 800 ||
      value.height < 600
    ) {
      return null;
    }

    const state = value as WindowState;
    const visible = screen.getAllDisplays().some(({ workArea }) => {
      const overlapWidth =
        Math.min(state.x + state.width, workArea.x + workArea.width) -
        Math.max(state.x, workArea.x);
      const overlapHeight =
        Math.min(state.y + state.height, workArea.y + workArea.height) -
        Math.max(state.y, workArea.y);
      return overlapWidth >= 120 && overlapHeight >= 80;
    });
    if (!visible) return null;

    return {
      ...state,
      maximized: value.maximized === true,
      fullscreen: value.fullscreen === true,
    };
  } catch {
    return null;
  }
}

export function trackWindowState(window: BrowserWindow): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const save = () => {
    try {
      if (window.isDestroyed()) return;
      const state: WindowState = {
        ...window.getNormalBounds(),
        maximized: window.isMaximized(),
        fullscreen: window.isFullScreen(),
      };
      mkdirSync(dirname(stateFile()), { recursive: true });
      writeFileSync(stateFile(), JSON.stringify(state));
    } catch (error) {
      console.warn("Failed to persist window state", error);
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 250);
  };

  window.on("move", schedule);
  window.on("resize", schedule);
  window.on("maximize", schedule);
  window.on("unmaximize", schedule);
  window.on("enter-full-screen", schedule);
  window.on("leave-full-screen", schedule);
  window.on("closed", () => clearTimeout(timer));

  return save;
}
