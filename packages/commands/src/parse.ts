/** A slash command split into its name and raw argument string. */
export interface ParsedCommand {
  /** Command name without the leading slash (lowercased). */
  name: string;
  /** Everything after the name — preserves quoting and newlines. */
  args: string;
}

/**
 * Parse a submitted input into a command name + raw args, or null when it is
 * not a slash command. Only the first line is inspected for the name; any
 * further lines are kept as part of `args` (matches opencode's client split).
 */
export function parseCommandInput(input: string): ParsedCommand | null {
  if (!input.startsWith("/")) return null;
  const newline = input.indexOf("\n");
  const firstLine = newline === -1 ? input : input.slice(0, newline);
  const rest = newline === -1 ? "" : input.slice(newline); // includes the "\n"

  const space = firstLine.indexOf(" ");
  const name = (space === -1 ? firstLine.slice(1) : firstLine.slice(1, space)).toLowerCase();
  const firstLineArgs = space === -1 ? "" : firstLine.slice(space + 1);
  const args = (firstLineArgs + rest).trim();

  if (!name) return null;
  return { name, args };
}

// Tokens: a double- or single-quoted run, or a bare non-whitespace run.
const ARG_TOKEN = /"[^"]*"|'[^']*'|[^\s"']+/g;
const QUOTE_TRIM = /^["']|["']$/g;

/**
 * Split a raw argument string into positional tokens, respecting quotes so
 * `"two words"` stays a single argument. Surrounding quotes are stripped.
 */
export function tokenizeArgs(raw: string): string[] {
  const matches = raw.match(ARG_TOKEN);
  if (!matches) return [];
  return matches.map((token) => token.replace(QUOTE_TRIM, ""));
}
