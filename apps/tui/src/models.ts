import type { ProviderConfig } from "@cozycode/protocol";

/**
 * Query an OpenAI-compatible provider's `/models` endpoint for its catalogue.
 * Fails soft — any network/parse error yields an empty list so the model
 * selector still works from the configured list and the current model alone.
 */
export async function fetchModels(provider: ProviderConfig): Promise<string[]> {
  const url = `${provider.baseURL.replace(/\/$/, "")}/models`;
  try {
    const res = await fetch(url, {
      headers: {
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
        ...provider.headers,
      },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? [])
      .map((m) => (typeof m.id === "string" ? m.id : null))
      .filter((id): id is string => id !== null);
    return ids.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Merge model sources into a de-duplicated, sorted list, always including the
 * current model so it stays selectable even when discovery is unavailable.
 */
export function mergeModels(current: string, configured?: string[], fetched?: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const id of [current, ...(configured ?? []), ...(fetched ?? [])]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}
