import { Check } from "lucide-react";
import { effortsForModel } from "@cozycode/commands";
import { useApp } from "../store/app-store";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const DEFAULT = "__default__";

/**
 * Reasoning-effort pill shown next to the model picker. Rendered only when the
 * current model exposes an effort ladder; lets the user pick a level or clear
 * to the provider default.
 */
export function EffortPicker() {
  const model = useApp((s) => s.model);
  const providers = useApp((s) => s.providers);
  const effort = useApp((s) => s.effort);
  const setEffort = useApp((s) => s.setEffort);
  const open = useApp((s) => s.effortPickerOpen);
  const setOpen = useApp((s) => s.setEffortPickerOpen);

  const efforts = effortsForModel(providers ?? { all: [], connected: [] }, model);
  if (efforts.length === 0) return null;

  const choose = (value: string) => {
    setEffort(value === DEFAULT ? undefined : value);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-7 items-center rounded-full px-2.5 text-xs transition-colors hover:bg-white/10",
            effort ? "text-cozy-200" : "text-muted-foreground",
          )}
        >
          {effort ?? "effort"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-0">
        <Command>
          <CommandList>
            <CommandEmpty>No levels.</CommandEmpty>
            <CommandGroup>
              <CommandItem value={DEFAULT} onSelect={() => choose(DEFAULT)}>
                <span className="flex-1">Default</span>
                {!effort && <Check className="size-4 text-primary" />}
              </CommandItem>
              {efforts.map((level) => (
                <CommandItem key={level} value={level} onSelect={() => choose(level)}>
                  <span className="flex-1 capitalize">{level}</span>
                  {effort === level && <Check className="size-4 text-primary" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
