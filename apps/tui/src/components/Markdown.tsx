import { syntaxStyle, theme } from "../theme.ts";

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const height = Math.max(1, text.split("\n").length + 2);
  return (
    <box flexDirection="column">
      <markdown content={text} fg={theme.text} syntaxStyle={syntaxStyle} streaming={streaming} height={height} />
      {streaming ? <text fg={theme.muted}>▍</text> : null}
    </box>
  );
}
