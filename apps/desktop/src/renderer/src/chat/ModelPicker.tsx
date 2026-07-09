import { ChevronDown } from "lucide-react";
import { useApp } from "../store/app-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Trim a long provider model id to something pill-sized, e.g. "…/gpt-4o". */
function shortModel(id: string): string {
  if (!id) return "Model";
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function ModelPicker() {
  const model = useApp((s) => s.model);
  const models = useApp((s) => s.models);
  const setModel = useApp((s) => s.setModel);
  const refresh = useApp((s) => s.refreshModels);

  return (
    <DropdownMenu onOpenChange={(o) => o && void refresh()}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="app-no-drag flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
        >
          <span className="max-w-[160px] truncate">{shortModel(model)}</span>
          <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 min-w-[220px]">
        {models.length === 0 && (
          <div className="px-2 py-1.5 text-sm text-muted-foreground">No models found</div>
        )}
        {models.map((m) => (
          <DropdownMenuItem key={m} onSelect={() => setModel(m)}>
            <span className="truncate">{m}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
