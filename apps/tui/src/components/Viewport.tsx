import { useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { RenderItem } from "../transcript.ts";
import { theme } from "../theme.ts";
import { Item } from "./Item.tsx";

interface Props {
  items: RenderItem[];
  inputEnabled: boolean;
  earlierItemsOmitted?: boolean;
  onOpenSubagent?: (sessionId: string) => void;
}

/**
 * The scrollable transcript. Uses OpenTUI's native scrollbox with sticky
 * bottom scroll, so the view auto-pins to the newest content while streaming
 * and stays put once the user scrolls up. Mouse wheel is handled natively;
 * keys drive page/line/home/end scrolling.
 */
export function Viewport({ items, inputEnabled, earlierItemsOmitted = false, onOpenSubagent }: Props) {
  const scroll = useRef<ScrollBoxRenderable | null>(null);

  useKeyboard((key) => {
    if (!inputEnabled) return;
    const box = scroll.current;
    if (!box) return;
    const page = Math.max(1, Math.floor(box.height / 2));
    if (key.name === "pageup") box.scrollBy(-page);
    else if (key.name === "pagedown") box.scrollBy(page);
    else if (key.name === "home") box.scrollTo(0);
    else if (key.name === "end") box.scrollTo(box.scrollHeight);
  });

  return (
    <scrollbox
      ref={(r: ScrollBoxRenderable | null) => {
        scroll.current = r;
      }}
      stickyScroll
      stickyStart="bottom"
      flexGrow={1}
      verticalScrollbarOptions={{
        trackOptions: { backgroundColor: theme.panel, foregroundColor: theme.border },
      }}
    >
      {earlierItemsOmitted ? (
        <box paddingLeft={3} paddingY={1}>
          <text fg={theme.muted}>Earlier transcript omitted. Showing recent activity.</text>
        </box>
      ) : null}
      {items.map((item) => (
        <Item key={item.id} item={item} onOpenSubagent={onOpenSubagent} />
      ))}
    </scrollbox>
  );
}
