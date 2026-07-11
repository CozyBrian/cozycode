/** Keep generated commit messages safe for `git commit -m` arguments. */
export function splitCommitDraft(text: string): { subject: string; body: string } {
  const lines = text.trim().split("\n");
  const subject = lines.shift()?.trim() ?? "";
  const blank = lines.findIndex((line) => !line.trim());
  return { subject, body: (blank === -1 ? [] : lines.slice(blank + 1)).join("\n").trim() };
}
