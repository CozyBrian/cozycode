import type { RenderItem } from "../transcript.ts";
import { Message } from "./Message.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { theme } from "../theme.ts";

/** Render a single transcript item (user / assistant / tool / error / system). */
export function Item({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case "user":
    case "assistant":
    case "error":
      return <Message item={item} />;
    case "tool":
      return <ToolRow item={item} />;
    case "system":
      return (
        <box marginTop={1} justifyContent="center">
          <text fg={theme.muted}>{item.text}</text>
        </box>
      );
  }
}
