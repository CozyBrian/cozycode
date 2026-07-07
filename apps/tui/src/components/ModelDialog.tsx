import { useEffect, useMemo, useState } from "react";
import type { ProviderConfig } from "@cozycode/protocol";
import { fetchModels, mergeModels } from "../models.ts";
import { DialogSelect, type SelectItem } from "./DialogSelect.tsx";

interface Props {
  provider: ProviderConfig;
  current: string;
  /** Explicit model list from config, if any. */
  configured?: string[];
  onSelect: (model: string) => void;
  onCancel: () => void;
}

/**
 * Model selector: shows the current model immediately, then discovers the
 * provider's catalogue from its `/models` endpoint and merges it in. Selecting
 * a model switches it live (the caller wires this to Session.setModel).
 */
export function ModelDialog({ provider, current, configured, onSelect, onCancel }: Props) {
  const [fetched, setFetched] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void fetchModels(provider).then((ids) => {
      if (cancelled) return;
      setFetched(ids);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [provider]);

  const options = useMemo<SelectItem<string>[]>(() => {
    const models = mergeModels(current, configured, fetched);
    return models.map((id) => ({ value: id, title: id, current: id === current }));
  }, [current, configured, fetched]);

  return (
    <DialogSelect
      title="Switch model"
      placeholder="Filter models…"
      hint={loading ? "discovering models…" : undefined}
      options={options}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}
