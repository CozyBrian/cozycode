import { theme } from "../theme.ts";

const KEYS = [
  ["enter", "send message"],
  ["shift+enter", "newline (or ctrl+j)"],
  ["esc", "interrupt or close overlay"],
  ["ctrl+p", "command palette"],
  ["ctrl+o", "switch model"],
  ["ctrl+b", "toggle sidebar"],
  ["pgup/pgdn", "scroll transcript"],
  ["home/end", "jump transcript"],
  ["/new /clear", "reset chat"],
  ["/model", "switch model"],
  ["/help", "show this help"],
  ["/quit", "quit"],
] as const;

export function Help() {
  return (
    <box justifyContent="center" marginY={1}>
      <box flexDirection="column" width={50} borderStyle="rounded" borderColor={theme.accent} backgroundColor={theme.panel} paddingX={2} paddingY={1}>
        <text fg={theme.text}>Help</text>
        <box flexDirection="column" marginTop={1}>
          {KEYS.map(([keyName, label]) => (
            <text key={keyName}>
              <span style={{ fg: theme.primary }}>{keyName.padEnd(12)}</span>
              <span style={{ fg: theme.muted }}>{label}</span>
            </text>
          ))}
        </box>
      </box>
    </box>
  );
}
