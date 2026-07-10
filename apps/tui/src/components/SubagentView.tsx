import { useKeyboard } from "@opentui/react";
import type { SubagentBlock } from "../transcript.ts";
import { theme } from "../theme.ts";
import { Viewport } from "./Viewport.tsx";

interface Props {
  block: SubagentBlock;
  onClose: () => void;
}

/** Full-screen read-only view of a subagent's transcript. esc returns to the parent. */
export function SubagentView({ block, onClose }: Props) {
  useKeyboard((key) => {
    if (key.name === "escape") onClose();
  });

  const statusLabel =
    block.status === "running" ? "running…" : block.status === "error" ? "failed" : "done";

  return (
    <box flexDirection="column" flexGrow={1}>
      <box flexDirection="row" justifyContent="space-between" paddingX={1} paddingBottom={1}>
        <text fg={theme.primary}>
          {"▸ "}
          {block.agent}
          <span style={{ fg: theme.muted }}>{`  ${block.description}`}</span>
        </text>
        <text fg={theme.muted}>{`${statusLabel} · esc back`}</text>
      </box>
      <Viewport items={block.items} inputEnabled />
    </box>
  );
}
