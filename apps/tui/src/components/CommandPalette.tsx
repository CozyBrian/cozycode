import type { SelectOption } from "@opentui/core";
import { listCommands } from "@cozycode/commands";
import { theme } from "../theme.ts";

// Options are derived from the shared command registry, so the palette never
// drifts from the parser or help. `value` is the canonical command name.
const OPTIONS: SelectOption[] = listCommands().map((command) => ({
  name: command.title ?? command.name,
  description: command.description,
  value: command.name,
}));

export function CommandPalette({ onSelect }: { onSelect: (name: string) => void }) {
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
            onSelect={(_index, option) => option?.value && onSelect(option.value as string)}
          />
        </box>
      </box>
    </box>
  );
}
