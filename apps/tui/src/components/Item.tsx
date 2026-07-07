import type { RenderItem } from "../transcript.ts";
import { Message } from "./Message.tsx";
import { ToolRow } from "./ToolRow.tsx";

/** Render a single transcript item (user / assistant / tool / error). */
export function Item({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case "user":
    case "assistant":
    case "error":
      return <Message item={item} />;
    case "tool":
      return <ToolRow item={item} />;
  }
}
