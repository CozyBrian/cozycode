import { useMemo } from "react";
import type { ModelRef, ProviderList } from "@cozycode/protocol";
import { DialogSelect, type SelectItem } from "./DialogSelect.tsx";

interface Props {
  providers: ProviderList;
  current: ModelRef | null;
  recents: ModelRef[];
  onSelect: (model: ModelRef) => void;
  onConnect: () => void;
  onCancel: () => void;
}

type Choice = ModelRef | "connect";

export function ModelDialog({ providers, current, recents, onSelect, onConnect, onCancel }: Props) {
  const options = useMemo<SelectItem<Choice>[]>(() => {
    const same = (ref: ModelRef) =>
      current?.providerID === ref.providerID && current.modelID === ref.modelID;
    const connected = new Set(providers.connected);
    const available = (ref: ModelRef) => providers.all.some(
      (provider) => provider.id === ref.providerID && connected.has(provider.id) &&
        provider.models.some((model) => model.id === ref.modelID),
    );
    const recentOptions = recents.filter(available).slice(0, 5).map((ref) => {
      const provider = providers.all.find((item) => item.id === ref.providerID)!;
      const model = provider.models.find((item) => item.id === ref.modelID)!;
      return { value: ref, title: model.name, description: provider.name, category: "Recent", current: same(ref) };
    });
    const modelOptions = providers.all.flatMap((provider) =>
      connected.has(provider.id)
        ? provider.models.map((model) => {
            const ref = { providerID: provider.id, modelID: model.id };
            return {
              value: ref,
              title: model.name,
              description: model.id === model.name ? undefined : model.id,
              category: provider.name,
              current: same(ref),
            };
          })
        : [],
    );
    return [
      ...recentOptions,
      ...modelOptions,
      { value: "connect", title: "Connect a provider…", category: "Providers" },
    ];
  }, [current, providers, recents]);

  return (
    <DialogSelect
      title="Switch model"
      placeholder="Filter models…"
      options={options}
      onSelect={(choice) => choice === "connect" ? onConnect() : onSelect(choice)}
      onCancel={onCancel}
    />
  );
}
