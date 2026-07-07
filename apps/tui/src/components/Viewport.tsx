import { useEffect, useMemo, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { RenderItem } from "../transcript.ts";
import { Item } from "./Item.tsx";

interface Props {
  items: RenderItem[];
  height?: number;
  inputEnabled: boolean;
}

export function Viewport({ items, height, inputEnabled }: Props) {
  const dimensions = useTerminalDimensions();
  const [scrollOffset, setScrollOffset] = useState(0);
  const viewportHeight = height || Math.max(0, dimensions.height - 6);
  const contentHeight = useMemo(() => items.reduce((sum, item) => sum + estimateHeight(item), 0), [items]);
  const maxScroll = Math.max(0, contentHeight - viewportHeight);

  useEffect(() => {
    setScrollOffset(maxScroll);
  }, [items.length, maxScroll]);

  useKeyboard((key) => {
    if (!inputEnabled || viewportHeight <= 0) return;
    if (key.name === "pageup") setScrollOffset((s) => Math.max(0, s - Math.max(1, viewportHeight - 2)));
    if (key.name === "pagedown") setScrollOffset((s) => Math.min(maxScroll, s + Math.max(1, viewportHeight - 2)));
    if (key.name === "home") setScrollOffset(0);
    if (key.name === "end") setScrollOffset(maxScroll);
  });

  if (!viewportHeight) {
    return (
      <box flexDirection="column">
        {items.map((item) => <Item key={item.id} item={item} />)}
      </box>
    );
  }

  const visible = sliceVisible(items, scrollOffset, viewportHeight);
  return (
    <box flexDirection="column" height={viewportHeight} overflow="hidden">
      {visible.map((item) => <Item key={item.id} item={item} />)}
    </box>
  );
}

function sliceVisible(items: RenderItem[], offset: number, height: number): RenderItem[] {
  let cursor = 0;
  const visible: RenderItem[] = [];
  for (const item of items) {
    const itemHeight = estimateHeight(item);
    if (cursor + itemHeight >= offset && cursor <= offset + height) visible.push(item);
    cursor += itemHeight;
  }
  return visible.length ? visible : items.slice(-Math.max(1, height));
}

function estimateHeight(item: RenderItem): number {
  if (item.kind === "tool") return 2 + (item.result === undefined ? 0 : 4);
  if (item.kind === "assistant") return Math.max(2, item.text.split("\n").length + 1);
  return Math.max(2, item.text.split("\n").length + 1);
}
