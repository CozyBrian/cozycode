import type { SessionMeta } from "./ipc.ts";

/** Preserve project order while ensuring the default root is included exactly once. */
export function workspaceRoots(defaultRoot: string, roots?: readonly string[]): string[] {
  return [...new Set([...(roots ?? []), defaultRoot].filter(Boolean))];
}

/** Empty chats are reusable only inside the requested project. */
export function emptySessionForWorkspace<T extends Pick<SessionMeta, "messageCount" | "workspaceRoot">>(
  sessions: readonly T[],
  workspaceRoot: string | null,
): T | undefined {
  return sessions.find((session) => session.messageCount === 0 && session.workspaceRoot === workspaceRoot);
}
