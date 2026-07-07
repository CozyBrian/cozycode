import type { TokenUsage } from "@cozycode/protocol";
import { shortPath, theme } from "../theme.ts";

interface Props {
  busy: boolean;
  inputKey: number;
  model: string;
  workspaceRoot: string;
  usage?: TokenUsage;
  onSubmit: (value: string) => void;
}

export function Prompt({ busy, inputKey, model, workspaceRoot, usage, onSubmit }: Props) {
  return (
    <box
      flexDirection="column"
      borderStyle="heavy"
      borderColor={theme.primary}
      border={["left"]}
      backgroundColor={theme.element}
      paddingLeft={2}
      paddingTop={1}
    >
      <box flexDirection="row">
        <text fg={theme.primary}>› </text>
        {busy ? <text fg={theme.muted}>working…</text> : <input key={inputKey} focused placeholder="Ask anything…" onSubmit={onSubmit as never} />}
      </box>
      <text fg={theme.muted}>{model} · {shortPath(workspaceRoot)}</text>
      <box flexDirection="row" justifyContent="space-between">
        {busy ? (
          <text fg={theme.muted}>esc interrupt ~</text>
        ) : (
          <text fg={theme.muted}>ctrl+p commands · /help</text>
        )}
        <text fg={theme.muted}>{usageLabel(usage)}</text>
      </box>
    </box>
  );
}

function usageLabel(usage?: TokenUsage): string {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return `${input}→${output} tokens`;
}
