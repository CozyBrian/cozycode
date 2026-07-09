const UNITS: [limit: number, div: number, suffix: string][] = [
  [60_000, 1000, "s"],
  [3_600_000, 60_000, "m"],
  [86_400_000, 3_600_000, "h"],
  [604_800_000, 86_400_000, "d"],
  [2_629_800_000, 604_800_000, "w"],
  [31_557_600_000, 2_629_800_000, "mo"],
];

/** Compact relative time like the sidebar in the mock: "5m", "3h", "2d", "3mo". */
export function relativeTime(from: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - from);
  if (diff < 45_000) return "now";
  for (const [limit, div, suffix] of UNITS) {
    if (diff < limit) return `${Math.floor(diff / div)}${suffix}`;
  }
  return `${Math.floor(diff / 31_557_600_000)}y`;
}
