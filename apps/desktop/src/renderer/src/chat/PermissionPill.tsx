import { AlertTriangle, Check, ChevronDown, ShieldCheck, Telescope } from "lucide-react";
import { useApp } from "../store/app-store";
import type { PermissionPreset } from "../../../shared/ipc.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface PresetDef {
  value: PermissionPreset;
  label: string;
  icon: React.ReactNode;
  hint: string;
}

const ASK: PresetDef = {
  value: "ask",
  label: "Ask",
  icon: <ShieldCheck className="size-4" />,
  hint: "Confirm writes and shell commands",
};

const PRESETS: PresetDef[] = [
  {
    value: "full",
    label: "Full access",
    icon: <AlertTriangle className="size-4" />,
    hint: "Run and edit without asking",
  },
  ASK,
  {
    value: "plan",
    label: "Plan",
    icon: <Telescope className="size-4" />,
    hint: "Read-only research, no changes",
  },
];

export function PermissionPill() {
  const preset = useApp((s) => s.preset);
  const setPreset = useApp((s) => s.setPreset);
  const current = PRESETS.find((p) => p.value === preset) ?? ASK;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "app-no-drag flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium transition-colors",
            preset === "full" && "bg-warning/12 text-warning hover:bg-warning/18",
            preset === "ask" && "text-muted-foreground hover:bg-white/8 hover:text-foreground",
            preset === "plan" && "bg-primary/15 text-primary hover:bg-primary/22",
          )}
        >
          <span className="[&_svg]:size-3.5">{current.icon}</span>
          {current.label}
          <ChevronDown className="size-3.5 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        {PRESETS.map((p) => (
          <DropdownMenuItem key={p.value} onSelect={() => setPreset(p.value)}>
            {p.icon}
            <div className="flex min-w-0 flex-1 flex-col">
              <span>{p.label}</span>
              <span className="text-xs text-muted-foreground">{p.hint}</span>
            </div>
            {p.value === preset && <Check className="size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
