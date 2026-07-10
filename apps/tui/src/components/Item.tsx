import type { RenderItem } from "../transcript.ts";
import { Message } from "./Message.tsx";
import { Reasoning } from "./Reasoning.tsx";
import { ToolRow } from "./ToolRow.tsx";
import { theme } from "../theme.ts";

/** Render a single transcript item (user / assistant / reasoning / tool / error / system). */
export function Item({
  item,
  onOpenSubagent,
}: {
  item: RenderItem;
  onOpenSubagent?: (sessionId: string) => void;
}) {
  switch (item.kind) {
    case "user":
    case "assistant":
    case "error":
      return <Message item={item} />;
    case "reasoning":
      return <Reasoning item={item} />;
    case "tool":
      return <ToolRow item={item} onOpenSubagent={onOpenSubagent} />;
    case "system":
      return (
        <box marginTop={1} justifyContent="center">
          <text fg={theme.muted}>{item.text}</text>
        </box>
      );
  }
}
