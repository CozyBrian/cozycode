/** Compact token/count formatting shared across the model picker and panels. */

/** Format a token count as `1.1m` / `400k` / `512`. Returns undefined for 0/undefined. */
export function compactTokens(value?: number): string | undefined {
  if (!value) return undefined;
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

/** Like `compactTokens` but always returns a string (0 → "0"). */
export function compactTokensAlways(value: number): string {
  return compactTokens(value) ?? "0";
}
