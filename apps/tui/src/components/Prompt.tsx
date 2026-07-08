import { useRef } from "react";
import type { TextareaRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { AgentMode, TokenUsage } from "@cozycode/protocol";
import { shortPath, theme } from "../theme.ts";

interface Props {
  busy: boolean;
  inputKey: number;
  model: string;
  mode: AgentMode;
  workspaceRoot: string;
  usage?: TokenUsage;
  onSubmit: (value: string) => void;
  onToggleMode: () => void;
}

// Enter submits; Shift+Enter and Ctrl+J (linefeed) insert a newline. This
// overrides OpenTUI's default (Enter=newline, Meta+Enter=submit) to match
// opencode's prompt behavior. `linefeed` → newline is kept from the defaults.
const KEY_BINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "kpenter", shift: true, action: "newline" as const },
];

export function Prompt({ busy, inputKey, model, mode, workspaceRoot, usage, onSubmit, onToggleMode }: Props) {
  const dimensions = useTerminalDimensions();
  const input = useRef<TextareaRenderable | null>(null);
  const maxHeight = Math.max(6, Math.floor((dimensions.height || 24) / 3));

  const submit = () => {
    const box = input.current;
    if (!box) return;
    const text = box.plainText;
    box.setText("");
    onSubmit(text);
  };

  return (
    <box
      flexDirection="column"
      borderStyle="heavy"
      borderColor={busy ? theme.warning : theme.primary}
      border={["left"]}
      backgroundColor={theme.element}
      paddingLeft={2}
      paddingTop={1}
    >
      <textarea
        key={inputKey}
        ref={(r: TextareaRenderable | null) => {
          input.current = r;
        }}
        focused
        placeholder={mode === "plan" ? "Plan a task (read-only)…" : "Ask anything…"}
        minHeight={1}
        maxHeight={maxHeight}
        keyBindings={KEY_BINDINGS}
        backgroundColor={theme.element}
        onSubmit={submit}
        onKeyDown={(key) => {
          if (key.name === "tab") {
            key.preventDefault();
            onToggleMode();
          }
        }}
      />
      <text fg={theme.muted}>
        {mode === "plan" ? (
          <span style={{ fg: theme.accent }}>PLAN</span>
        ) : (
          <span style={{ fg: theme.success }}>BUILD</span>
        )}
        {" · "}
        {model} · {shortPath(workspaceRoot)}
      </text>
      <box flexDirection="row" justifyContent="space-between">
        {busy ? (
          <text fg={theme.warning}>● working · esc interrupt</text>
        ) : (
          <text fg={theme.muted}>ctrl+p commands · ctrl+o model · tab mode · /help</text>
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
