import { SyntaxStyle } from "@opentui/core";

export const theme = {
  bg: "#0a0a0a",
  panel: "#141414",
  element: "#1e1e1e",
  text: "#eeeeee",
  muted: "#808080",
  border: "#484848",
  borderActive: "#606060",
  primary: "#fab283",
  secondary: "#5c9cf5",
  accent: "#9d7cd8",
  success: "#7fd88f",
  warning: "#f5a742",
  error: "#e06c75",
  cyan: "#56b6c2",
  yellow: "#e5c07b",
  diff: {
    addedBg: "#20303b",
    removedBg: "#37222c",
    added: "#b8db87",
    removed: "#e26a75",
    lineNumber: "#8f8f8f",
  },
} as const;

export const syntaxStyle = SyntaxStyle.fromStyles({
  text: { fg: theme.text },
  heading: { fg: theme.primary, bold: true },
  strong: { fg: theme.text, bold: true },
  emphasis: { fg: theme.text, italic: true },
  link: { fg: theme.secondary, underline: true },
  code: { fg: theme.yellow },
  string: { fg: theme.success },
  number: { fg: theme.accent },
  keyword: { fg: theme.primary },
  function: { fg: theme.secondary },
  comment: { fg: theme.muted, dim: true },
});

export function shortPath(path: string): string {
  const home = process.env.HOME;
  const display = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  const parts = display.split("/").filter(Boolean);
  if (display.startsWith("~/") && parts.length > 3) return `~/…/${parts.slice(-2).join("/")}`;
  if (!display.startsWith("~/") && parts.length > 3) return `…/${parts.slice(-2).join("/")}`;
  return display || "/";
}
