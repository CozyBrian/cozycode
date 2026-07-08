import { useEffect, useRef, useState } from "react";
import type { TextareaRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { matchPrefix, type CommandDef } from "@cozycode/commands";
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

// The prefix being typed while completing a slash command: the whole input is
// a single "/token" (no space, single line). Anything else means no completion.
function commandQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? match[1]! : null;
}

export function Prompt({ busy, inputKey, model, mode, workspaceRoot, usage, onSubmit, onToggleMode }: Props) {
  const dimensions = useTerminalDimensions();
  const input = useRef<TextareaRenderable | null>(null);
  const maxHeight = Math.max(6, Math.floor((dimensions.height || 24) / 3));

  // Slash-command autocomplete state. `query` is null when not completing.
  const [query, setQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const suggestions = query === null ? [] : matchPrefix(query);
  const showSuggestions = suggestions.length > 0;

  // A fresh textarea (after submit/reset remounts it) starts empty.
  useEffect(() => setQuery(null), [inputKey]);

  const submit = () => {
    const box = input.current;
    if (!box) return;
    const text = box.plainText;
    box.setText("");
    setQuery(null);
    onSubmit(text);
  };

  const accept = (command: CommandDef) => {
    input.current?.setText(`/${command.name} `);
    setQuery(null);
  };

  return (
    <box flexDirection="column">
      {showSuggestions ? (
        <box flexDirection="column" marginBottom={1} borderStyle="rounded" borderColor={theme.borderActive} backgroundColor={theme.panel} paddingX={1}>
          {suggestions.map((command, index) => (
            <text key={command.name} bg={index === selected ? theme.primary : undefined}>
              <span style={{ fg: index === selected ? theme.bg : theme.text }}>{`/${command.name}`.padEnd(12)}</span>
              <span style={{ fg: index === selected ? theme.bg : theme.muted }}>{command.description}</span>
            </text>
          ))}
        </box>
      ) : null}
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
          onContentChange={() => {
            setQuery(commandQuery(input.current?.plainText ?? ""));
            setSelected(0);
          }}
          onKeyDown={(key) => {
            if (showSuggestions) {
              if (key.name === "up") {
                key.preventDefault();
                setSelected((s) => (s - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (key.name === "down") {
                key.preventDefault();
                setSelected((s) => (s + 1) % suggestions.length);
                return;
              }
              if (key.name === "tab" || key.name === "return" || key.name === "kpenter") {
                key.preventDefault();
                const command = suggestions[selected];
                if (command) accept(command);
                return;
              }
              if (key.name === "escape") {
                key.preventDefault();
                setQuery(null);
                return;
              }
            }
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
    </box>
  );
}

function usageLabel(usage?: TokenUsage): string {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return `${input}→${output} tokens`;
}
