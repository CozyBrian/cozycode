export type PromptTrigger = CommandTrigger | ShellTrigger | FileReferenceTrigger;

export interface CommandTrigger {
  kind: "command";
  query: string;
  start: number;
  end: number;
}

export interface ShellTrigger {
  kind: "shell";
  query: string;
  start: number;
  end: number;
}

export interface FileReferenceTrigger {
  kind: "file";
  query: string;
  start: number;
  end: number;
}

export function detectCommandTrigger(text: string, cursor = text.length): CommandTrigger | undefined {
  const end = clampCursor(text, cursor);
  const prefix = text.slice(0, end);
  if (!prefix.startsWith("/") || /\s/.test(prefix)) return;
  return { kind: "command", query: prefix.slice(1), start: 0, end };
}

export function detectShellTrigger(text: string, cursor = text.length): ShellTrigger | undefined {
  const end = clampCursor(text, cursor);
  if (end === 0 || text[0] !== "!") return;
  return { kind: "shell", query: text.slice(1, end), start: 0, end };
}

export function detectFileReferenceTrigger(text: string, cursor = text.length): FileReferenceTrigger | undefined {
  const end = clampCursor(text, cursor);
  const prefix = text.slice(0, end);
  let start = prefix.lastIndexOf("@");
  while (start >= 0) {
    const before = start === 0 ? undefined : prefix[start - 1];
    const query = prefix.slice(start + 1);
    if ((before === undefined || /\s/.test(before)) && !/\s/.test(query)) {
      return { kind: "file", query, start, end };
    }
    start = start === 0 ? -1 : prefix.lastIndexOf("@", start - 1);
  }
  return;
}

export function detectPromptTrigger(text: string, cursor = text.length): PromptTrigger | undefined {
  return (
    detectFileReferenceTrigger(text, cursor) ??
    detectCommandTrigger(text, cursor) ??
    detectShellTrigger(text, cursor)
  );
}

export function replacePromptTrigger(
  text: string,
  trigger: PromptTrigger,
  value: string,
  suffix?: string,
): { text: string; cursor: number } {
  const trailing = suffix ?? (trigger.kind === "shell" || text[trigger.end] === " " ? "" : " ");
  const replacement = `${trigger.kind === "command" ? "/" : trigger.kind === "file" ? "@" : "!"}${value}${trailing}`;
  const next = text.slice(0, trigger.start) + replacement + text.slice(trigger.end);
  return { text: next, cursor: trigger.start + replacement.length };
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.trunc(cursor)));
}
