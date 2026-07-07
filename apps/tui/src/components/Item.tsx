import { Box, Text } from "ink";
import type { RenderItem, ToolStatus } from "../transcript.ts";

const STATUS_COLOR: Record<ToolStatus, string> = {
  running: "yellow",
  done: "green",
  error: "red",
  denied: "red",
};

const STATUS_LABEL: Record<ToolStatus, string> = {
  running: "…",
  done: "✓",
  error: "✗",
  denied: "⛔",
};

/** Render a single transcript item (user / assistant / tool / error). */
export function Item({ item }: { item: RenderItem }) {
  switch (item.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>
            {"› "}
          </Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1}>
          <Text>
            {item.text}
            {item.streaming ? <Text color="gray">▍</Text> : null}
          </Text>
        </Box>
      );
    case "tool":
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text>
            <Text color={STATUS_COLOR[item.status]}>{STATUS_LABEL[item.status]} </Text>
            <Text bold color="magenta">
              {item.toolName}
            </Text>
            <Text color="gray"> {oneLine(item.args)}</Text>
          </Text>
          {item.result !== undefined && item.status !== "running" ? (
            <Box marginLeft={2}>
              <Text color="gray">{preview(item.result)}</Text>
            </Box>
          ) : null}
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">⚠ {item.text}</Text>
        </Box>
      );
  }
}

function oneLine(value: unknown): string {
  const s = JSON.stringify(value) ?? "";
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}

function preview(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const text = s ?? "";
  const lines = text.split("\n").slice(0, 8);
  const clipped = lines.join("\n");
  return clipped.length > 600 ? clipped.slice(0, 600) + "\n…" : clipped;
}
