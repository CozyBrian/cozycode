import { Check } from "lucide-react";
import { effortsForModel } from "@cozycode/commands";
import { useApp } from "../store/app-store";
import { EffortBars } from "../components/EffortBars";
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

  // Lit-bar count for the selected level (0 when on the provider default).
  const activeFilled = effort ? efforts.indexOf(effort) + 1 : 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`Reasoning effort: ${effort ?? "default"}`}
          className={cn(
            "flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs capitalize transition-colors hover:bg-white/10",
            effort ? "text-cozy-200" : "text-muted-foreground",
          )}
        >
          <EffortBars filled={activeFilled} total={efforts.length} />
          {effort ?? "None"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-0">
        <Command>
          <CommandList>
            <CommandEmpty>No levels.</CommandEmpty>
            <CommandGroup>
              <CommandItem value={DEFAULT} onSelect={() => choose(DEFAULT)}>
                <EffortBars filled={0} total={efforts.length} className="text-muted-foreground" />
                <span className="flex-1">Default</span>
                {!effort && <Check className="size-4 text-primary" />}
              </CommandItem>
              {efforts.map((level, index) => (
                <CommandItem key={level} value={level} onSelect={() => choose(level)}>
                  <EffortBars
                    filled={index + 1}
                    total={efforts.length}
                    className={effort === level ? "text-cozy-200" : "text-muted-foreground"}
                  />
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
