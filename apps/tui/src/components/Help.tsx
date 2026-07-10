import { listCommands } from "@cozycode/commands";
import { theme } from "../theme.ts";

// Keybindings are documented here; slash commands are pulled from the shared
// registry below so they never drift from what the parser accepts.
const KEYS = [
  ["enter", "send message"],
  ["shift+enter", "newline (or ctrl+j)"],
  ["esc", "interrupt or close overlay"],
  ["ctrl+p", "command palette"],
  ["ctrl+o", "switch model"],
  ["ctrl+t", "cycle reasoning effort"],
  ["tab", "toggle plan / build"],
  ["ctrl+b", "toggle sidebar"],
  ["pgup/pgdn", "scroll transcript"],
  ["home/end", "jump transcript"],
] as const;

// e.g. "/new /clear" → "reset chat". Aliases render alongside the canonical name.
const COMMANDS = listCommands().map(
  (command): readonly [string, string] => [
    [command.name, ...(command.aliases ?? [])].map((n) => `/${n}`).join(" "),
    command.description,
  ],
);

const ROWS: readonly (readonly [string, string])[] = [...KEYS, ...COMMANDS];

export function Help() {
  return (
    <box justifyContent="center" marginY={1}>
      <box flexDirection="column" width={50} borderStyle="rounded" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={2} paddingY={1}>
        <text fg={theme.text}>Help</text>
        <box flexDirection="column" marginTop={1}>
          {ROWS.map(([keyName, label]) => (
            <text key={keyName}>
              <span style={{ fg: theme.primary }}>{keyName.padEnd(14)}</span>
              <span style={{ fg: theme.muted }}>{label}</span>
            </text>
          ))}
        </box>
      </box>
    </box>
  );
}
