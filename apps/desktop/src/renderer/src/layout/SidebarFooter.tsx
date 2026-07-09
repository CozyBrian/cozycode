import { Smartphone } from "lucide-react";
import { useApp } from "../store/app-store";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

export function SidebarFooter() {
  const model = useApp((s) => s.model);
  const providers = useApp((s) => s.providers);
  const openSettings = useApp((s) => s.openSettings);
  const name = providers?.all.find((provider) => provider.id === model?.providerID)?.name ?? "cozy";

  return (
    <button
      type="button"
      onClick={() => openSettings()}
      className="app-no-drag flex w-full items-center gap-2.5 border-t border-sidebar-border px-3 py-3 text-left transition-colors hover:bg-white/6"
    >
      <Avatar className="size-7">
        <AvatarFallback>{name.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate text-sm font-medium text-sidebar-foreground">{name}</div>
        <div className="text-xs text-muted-foreground">cozycode</div>
      </div>
      <Smartphone className="size-4 text-muted-foreground" />
    </button>
  );
}
