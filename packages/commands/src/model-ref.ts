import type { ModelRef, ProviderList } from "@cozycode/protocol";

export type ResolveModelRefResult = ModelRef | { error: string };

export function resolveModelRef(
  input: string,
  providers: ProviderList,
): ResolveModelRefResult {
  const value = input.trim();
  if (!value) return { error: "Model id is required." };

  const slash = value.indexOf("/");
  if (slash > 0) {
    const providerID = value.slice(0, slash);
    const modelID = value.slice(slash + 1);
    const provider = providers.all.find(
      (item) => item.id === providerID && providers.connected.includes(item.id),
    );
    if (!provider) return { error: `Provider is not connected: ${providerID}` };
    if (!provider.models.some((model) => model.id === modelID)) {
      return { error: `Unknown model: ${value}` };
    }
    return { providerID, modelID };
  }

  const matches = providers.all.flatMap((provider) =>
    providers.connected.includes(provider.id) && provider.models.some((model) => model.id === value)
      ? [{ providerID: provider.id, modelID: value }]
      : [],
  );
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    return { error: `Model id is ambiguous; use provider/model: ${value}` };
  }
  return { error: `Unknown model: ${value}` };
}
