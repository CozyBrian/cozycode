import { resolve, relative, isAbsolute } from "node:path";

/**
 * Resolve a user/agent-supplied path against the workspace root and guarantee
 * it stays inside the workspace. Tools call this before any filesystem access
 * so the agent can't read or write outside the directory it was pointed at.
 *
 * @throws if the resolved path escapes `workspaceRoot`.
 */
export function resolveInWorkspace(workspaceRoot: string, inputPath: string): string {
  const root = resolve(workspaceRoot);
  const resolved = isAbsolute(inputPath)
    ? resolve(inputPath)
    : resolve(root, inputPath);

  const rel = relative(root, resolved);
  const escapes = rel === ".." || rel.startsWith(`..${sep()}`) || isAbsolute(rel);
  if (escapes) {
    throw new Error(
      `Path "${inputPath}" resolves outside the workspace root and is not allowed.`,
    );
  }
  return resolved;
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}
