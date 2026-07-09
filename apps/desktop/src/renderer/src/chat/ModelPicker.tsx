import { Check, ChevronDown, Plus } from "lucide-react";
import type { ModelRef, ProviderInfo } from "@cozycode/protocol";
import { useApp } from "../store/app-store";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function contextWindow(value?: number): string | undefined {
  if (!value) return undefined;
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function same(a: ModelRef | null, b: ModelRef): boolean {
  return a?.providerID === b.providerID && a.modelID === b.modelID;
}

function ModelItem({ provider, ref }: { provider: ProviderInfo; ref: ModelRef }) {
  const current = useApp((state) => state.model);
  const setModel = useApp((state) => state.setModel);
  const model = provider.models.find((item) => item.id === ref.modelID);
  if (!model) return null;
  return (
    <CommandItem
      value={`${provider.name} ${model.name} ${model.id}`}
      onSelect={() => setModel(ref)}
    >
      <span className="min-w-0 flex-1 truncate">{model.name}</span>
      {contextWindow(model.contextWindow) && (
        <span className="text-xs text-muted-foreground">{contextWindow(model.contextWindow)}</span>
      )}
      {same(current, ref) && <Check className="size-4 text-primary" />}
    </CommandItem>
  );
}

export function ModelPicker() {
  const model = useApp((state) => state.model);
  const providers = useApp((state) => state.providers);
  const recent = useApp((state) => state.recentModels);
  const open = useApp((state) => state.modelPickerOpen);
  const setOpen = useApp((state) => state.setModelPickerOpen);
  const provider = providers?.all.find((item) => item.id === model?.providerID);
  const modelInfo = provider?.models.find((item) => item.id === model?.modelID);
  const connected = providers?.all.filter((item) => providers.connected.includes(item.id)) ?? [];
  const resolvedRecent = recent.flatMap((ref) => {
    const item = providers?.all.find((candidate) => candidate.id === ref.providerID);
    return item?.models.some((candidate) => candidate.id === ref.modelID) ? [{ ref, provider: item }] : [];
  }).slice(0, 5);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void useApp.getState().refreshProviders();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="app-no-drag flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
        >
          <span className="max-w-40 truncate">
            {modelInfo?.name ?? model?.modelID ?? "Model"}
            {provider && <span className="text-muted-foreground/70"> · {provider.name}</span>}
          </span>
          <ChevronDown className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <Command>
          <CommandInput placeholder="Search models…" />
          <CommandList>
            <CommandEmpty>No matching models.</CommandEmpty>
            {resolvedRecent.length > 0 && (
              <CommandGroup heading="Recent">
                {resolvedRecent.map(({ ref, provider: recentProvider }) => (
                  <div key={`${ref.providerID}/${ref.modelID}`} className="relative">
                    <ModelItem provider={recentProvider} ref={ref} />
                    <Badge variant="outline" className="pointer-events-none absolute right-8 top-2">
                      {recentProvider.name}
                    </Badge>
                  </div>
                ))}
              </CommandGroup>
            )}
            {connected.map((item) => (
              <CommandGroup key={item.id} heading={item.name}>
                {item.models.map((candidate) => (
                  <ModelItem
                    key={candidate.id}
                    provider={item}
                    ref={{ providerID: item.id, modelID: candidate.id }}
                  />
                ))}
              </CommandGroup>
            ))}
            {connected.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">Connect a provider to choose a model.</p>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="connect a provider"
                onSelect={() => {
                  setOpen(false);
                  useApp.getState().openSettings("providers");
                }}
              >
                <Plus className="size-4" />
                Connect a provider…
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
