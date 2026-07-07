import { theme } from "../theme.ts";

export function Logo() {
  return (
    <box flexDirection="column" alignItems="center">
      <text>
        <span style={{ fg: theme.muted }}>▄▀▀ ▄▀▄ ▄▀▀ ▀▄ ▄</span>
        <b style={{ fg: theme.text }}> ▄▀▀ ▄▀▄ ▄▀▄ █▀</b>
      </text>
      <text>
        <span style={{ fg: theme.muted }}>█▄▄ ▀▄▀ ▄██ ▄▀ █</span>
        <b style={{ fg: theme.text }}> ▀▄▄ ▀▄▀ █▄█ █▄</b>
      </text>
      <box marginTop={1}>
        <text>
          <span style={{ fg: theme.muted }}>cozy</span>
          <b style={{ fg: theme.text }}>code</b>
        </text>
      </box>
    </box>
  );
}
