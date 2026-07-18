import { File, Folder } from "lucide-react";
import type { CommandDef } from "@cozycode/commands";
import type { WorkspaceReferenceSuggestion } from "../../../shared/ipc.ts";
import { cn } from "@/lib/utils";

export type ComposerSuggestion =
  | { kind: "command"; command: CommandDef }
  | { kind: "file"; file: WorkspaceReferenceSuggestion };

export function CommandSuggestions({
  suggestions,
  selected,
  onPick,
}: {
  suggestions: ComposerSuggestion[];
  selected: number;
  onPick: (suggestion: ComposerSuggestion) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <ul className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-xl border border-border bg-popover/95 p-1 shadow-lg backdrop-blur-xl">
      {suggestions.map((suggestion, index) => (
        <li key={suggestion.kind === "command" ? suggestion.command.name : suggestion.file.path}>
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(suggestion);
            }}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm",
              index === selected ? "bg-accent text-accent-foreground" : "hover:bg-white/5",
            )}
          >
            {suggestion.kind === "command" ? (
              <>
                <span className="font-mono text-primary">/{suggestion.command.name}</span>
                <span className="truncate text-muted-foreground">{suggestion.command.description}</span>
              </>
            ) : (
              <>
                {suggestion.file.directory
                  ? <Folder className="size-3.5 shrink-0 text-primary" />
                  : <File className="size-3.5 shrink-0 text-muted-foreground" />}
                <span className="truncate font-mono text-foreground">{suggestion.file.path}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {suggestion.file.directory ? "directory" : "file"}
                </span>
              </>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
