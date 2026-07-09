import type { CommandDef } from "@cozycode/commands";
import { cn } from "@/lib/utils";

export function CommandSuggestions({
  suggestions,
  selected,
  onPick,
}: {
  suggestions: CommandDef[];
  selected: number;
  onPick: (command: CommandDef) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <ul className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-xl border border-border bg-popover/95 p-1 shadow-lg backdrop-blur-xl">
      {suggestions.map((command, index) => (
        <li key={command.name}>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(command);
            }}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm",
              index === selected ? "bg-accent text-accent-foreground" : "hover:bg-white/5",
            )}
          >
            <span className="font-mono text-primary">/{command.name}</span>
            <span className="truncate text-muted-foreground">{command.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
