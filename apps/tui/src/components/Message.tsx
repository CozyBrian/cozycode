import type { RenderItem } from "../transcript.ts";
import { theme } from "../theme.ts";
import { Markdown } from "./Markdown.tsx";

export function Message({ item }: { item: Extract<RenderItem, { kind: "user" | "assistant" | "error" }> }) {
  if (item.kind === "user") {
    return (
      <box
        marginTop={1}
        paddingLeft={1}
        paddingY={1}
        borderStyle="heavy"
        borderColor={theme.secondary}
        border={["left"]}
        backgroundColor={theme.panel}
      >
        <text fg={theme.text}>{item.text}</text>
      </box>
    );
  }

  if (item.kind === "error") {
    return (
      <box
        marginTop={1}
        paddingLeft={1}
        borderStyle="heavy"
        borderColor={theme.error}
        border={["left"]}
      >
        <text fg={theme.muted}>{item.text}</text>
      </box>
    );
  }

  return (
    <box marginTop={1} paddingLeft={3}>
      <Markdown text={item.text} streaming={item.streaming} />
    </box>
  );
}
