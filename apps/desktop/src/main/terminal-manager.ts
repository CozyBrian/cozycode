import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { IPty } from "@lydell/node-pty";
import { IPC } from "../shared/ipc.ts";

interface TermInfo {
  termId: string;
  pty: IPty;
}

const isWindows = process.platform === "win32";

function defaultShell(): { file: string; args: string[] } {
  if (isWindows) return { file: "powershell.exe", args: [] };
  const file = process.env.SHELL || "/bin/zsh";
  // Login shell so the user's profile (PATH, prompt) is loaded.
  return { file, args: ["-l"] };
}

/**
 * Owns PTY-backed terminals for a window. Each tab is one long-lived shell
 * spawned in the active session's workspace. `@lydell/node-pty` is imported
 * lazily so a missing native binary breaks only the terminal feature, not app
 * boot.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, TermInfo>();
  private cwd: string = homedir();

  constructor(private readonly web: WebContents) {}

  /** Update the cwd used for shells opened from here on (per active session). */
  setCwd(cwd: string | null): void {
    this.cwd = cwd || homedir();
  }

  async create(opts: { cols: number; rows: number }): Promise<{ termId: string }> {
    const { spawn } = await import("@lydell/node-pty");
    const { file, args } = defaultShell();
    const pty = spawn(file, args, {
      name: "xterm-256color",
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: this.cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    const termId = randomUUID();
    this.terminals.set(termId, { termId, pty });

    pty.onData((data) => {
      if (!this.web.isDestroyed()) this.web.send(IPC.termData, { termId, data });
    });
    pty.onExit(({ exitCode }) => {
      this.terminals.delete(termId);
      if (!this.web.isDestroyed()) this.web.send(IPC.termExit, { termId, exitCode });
    });

    return { termId };
  }

  write(termId: string, data: string): void {
    this.terminals.get(termId)?.pty.write(data);
  }

  resize(termId: string, cols: number, rows: number): void {
    const term = this.terminals.get(termId);
    if (term && cols > 0 && rows > 0) term.pty.resize(cols, rows);
  }

  kill(termId: string): void {
    const term = this.terminals.get(termId);
    if (term) {
      this.terminals.delete(termId);
      try {
        term.pty.kill();
      } catch {
        // Already exited.
      }
    }
  }

  dispose(): void {
    for (const { pty } of this.terminals.values()) {
      try {
        pty.kill();
      } catch {
        // ignore
      }
    }
    this.terminals.clear();
  }
}
