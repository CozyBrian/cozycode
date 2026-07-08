import type { SelectOption } from "@opentui/core";
import { theme } from "../theme.ts";

export type Command = "new" | "clear" | "model" | "help" | "quit" | "plan" | "build";

const OPTIONS: SelectOption[] = [
  { name: "New chat", description: "Start a fresh session", value: "new" satisfies Command },
  { name: "Clear", description: "Clear the transcript", value: "clear" satisfies Command },
  { name: "Switch model", description: "Choose a different model", value: "model" satisfies Command },
  { name: "Plan mode", description: "Read-only research; no edits", value: "plan" satisfies Command },
  { name: "Build mode", description: "Execute changes (default)", value: "build" satisfies Command },
  { name: "Help", description: "Show keybindings", value: "help" satisfies Command },
  { name: "Quit", description: "Exit cozycode", value: "quit" satisfies Command },
];

export function CommandPalette({ onSelect }: { onSelect: (command: Command) => void }) {
  return (
    <box justifyContent="center" marginY={1}>
      <box flexDirection="column" width={42} height={12} borderStyle="rounded" borderColor={theme.borderActive} backgroundColor={theme.panel} paddingX={2} paddingY={1}>
        <text fg={theme.text}>Commands</text>
        <box marginTop={1} height={9}>
          <select
            focused
            options={OPTIONS}
            textColor={theme.text}
            selectedTextColor={theme.bg}
            selectedBackgroundColor={theme.primary}
            descriptionColor={theme.muted}
            onSelect={(_index, option) => option?.value && onSelect(option.value as Command)}
          />
        </box>
      </box>
    </box>
  );
}
