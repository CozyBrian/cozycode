import type { ModelRef, ProviderList } from "@cozycode/protocol";

/**
 * Reasoning-effort helpers shared by every frontend. Renderer-safe (no core /
 * Node imports): frontends read the ordered ladder that core shipped on
 * `ModelInfo.reasoningEfforts` and use these to persist, validate, and cycle a
 * per-model selection. Mirrors opencode's variant helpers.
 */

/** Stable per-model persistence key: "providerID/modelID". */
export function modelKey(ref: ModelRef): string {
  return `${ref.providerID}/${ref.modelID}`;
}

/** The effort ladder for the referenced model, or `[]` when none / not found. */
export function effortsForModel(providers: ProviderList, ref: ModelRef | null): string[] {
  if (!ref) return [];
  const provider = providers.all.find((p) => p.id === ref.providerID);
  const model = provider?.models.find((m) => m.id === ref.modelID);
  return model?.reasoningEfforts ?? [];
}

/**
 * Stale-drop: a stored level that is not in the current model's ladder resolves
 * to undefined (provider default), so switching to a model without that level
 * silently clears it.
 */
export function resolveEffort(
  stored: string | undefined,
  efforts: string[],
): string | undefined {
  return stored && efforts.includes(stored) ? stored : undefined;
}

/**
 * Next effort in the cycle: default → efforts[0] → … → last → default.
 * A no-op (returns `current`) when the model has no ladder.
 */
export function cycleEffort(
  current: string | undefined,
  efforts: string[],
): string | undefined {
  if (efforts.length === 0) return current;
  if (!current) return efforts[0];
  const index = efforts.indexOf(current);
  if (index === -1 || index === efforts.length - 1) return undefined;
  return efforts[index + 1];
}
