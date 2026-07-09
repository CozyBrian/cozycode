/**
 * Wildcard matcher for permission rules (ported from opencode).
 *
 * `*` matches any run of characters, `?` matches a single character; every
 * other regex metacharacter is escaped and matched literally. Backslashes are
 * normalized to forward slashes so path patterns match on all platforms.
 *
 * Special case: a pattern ending in `" *"` also matches the same string without
 * the trailing argument — so the rule `"git status *"` matches both
 * `git status --short` and the bare `git status`.
 */
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized);
}
