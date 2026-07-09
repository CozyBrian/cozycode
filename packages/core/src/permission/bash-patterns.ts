import { prefix } from "./arity.ts";

/**
 * Derives permission patterns from a shell command without a full shell parser.
 *
 * Returns the concrete `patterns` to evaluate (one per top-level command
 * segment) and the `always` patterns an "always allow" reply would grant
 * (command-prefix globs like `git commit *`).
 *
 * This is a deliberately conservative, lightweight replacement for a tree-sitter
 * parse. A segment that uses command substitution, redirection, a subshell/group,
 * or has unbalanced quotes cannot be safely reduced to a prefix, so it
 * contributes an exact `patterns` entry but *nothing* to `always` — it can never
 * be blanket-granted, only allowed once. Frontends hide the "always" option when
 * `always` is empty.
 */
export interface BashPermissionInput {
  patterns: string[];
  always: string[];
}

export function commandPatterns(command: string): BashPermissionInput {
  const patterns = new Set<string>();
  const always = new Set<string>();

  for (const raw of splitSegments(command)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const { tokens, masked, balanced } = scan(trimmed);
    patterns.add(trimmed);

    const conservative =
      !balanced ||
      /\$\(|`/.test(masked) || // command substitution
      /[<>]/.test(masked) || // redirection
      masked.trimStart().startsWith("(") || // subshell
      masked.trimStart().startsWith("{"); // group
    if (conservative) continue;

    // Strip leading `VAR=value` environment assignments before the command name.
    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx++;
    const cmdTokens = tokens.slice(idx);
    if (cmdTokens.length === 0) continue; // pure env assignment, nothing to grant

    const p = prefix(cmdTokens).join(" ");
    if (p) always.add(p + " *");
  }

  return { patterns: [...patterns], always: [...always] };
}

/** Split a command into top-level segments at `;`, `&&`, `||`, `|`, `&`, newline. */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let parenDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (inSingle) {
      cur += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      cur += ch;
      if (ch === "\\" && i + 1 < command.length) {
        cur += command[i + 1]!;
        i++;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      cur += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      cur += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      cur += ch + command[i + 1]!;
      i++;
      continue;
    }
    if (ch === "(") {
      parenDepth++;
      cur += ch;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth--;
      cur += ch;
      continue;
    }
    if (parenDepth === 0) {
      if (ch === ";" || ch === "\n") {
        segments.push(cur);
        cur = "";
        continue;
      }
      if (ch === "|") {
        segments.push(cur);
        cur = "";
        if (command[i + 1] === "|") i++;
        continue;
      }
      if (ch === "&") {
        segments.push(cur);
        cur = "";
        if (command[i + 1] === "&") i++;
        continue;
      }
    }
    cur += ch;
  }
  segments.push(cur);
  return segments;
}

/**
 * Quote-aware scan of one segment. Produces whitespace-split `tokens` (with
 * quotes/escapes resolved), a `masked` copy where quoted content is blanked (so
 * metacharacter detection ignores quoted text), and whether quotes were balanced.
 */
function scan(seg: string): { tokens: string[]; masked: string; balanced: boolean } {
  const tokens: string[] = [];
  let cur = "";
  let curHasContent = false;
  let masked = "";
  let inSingle = false;
  let inDouble = false;

  const flush = () => {
    if (curHasContent) {
      tokens.push(cur);
      cur = "";
      curHasContent = false;
    }
  };

  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i]!;
    if (inSingle) {
      masked += " ";
      if (ch === "'") inSingle = false;
      else {
        cur += ch;
        curHasContent = true;
      }
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && i + 1 < seg.length) {
        cur += seg[i + 1]!;
        curHasContent = true;
        masked += " ";
        i++;
        continue;
      }
      masked += " ";
      if (ch === '"') inDouble = false;
      else {
        cur += ch;
        curHasContent = true;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      curHasContent = true;
      masked += " ";
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      curHasContent = true;
      masked += " ";
      continue;
    }
    if (ch === "\\" && i + 1 < seg.length) {
      cur += seg[i + 1]!;
      curHasContent = true;
      masked += " ";
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      masked += ch;
      continue;
    }
    cur += ch;
    curHasContent = true;
    masked += ch;
  }
  flush();

  return { tokens, masked, balanced: !inSingle && !inDouble };
}
