export const ESCAPE_STOP_WINDOW_MS = 3_000;

export function confirmsEscapeStop(primedAt: number | null, now: number): boolean {
  if (primedAt === null) return false;
  const elapsed = now - primedAt;
  return elapsed >= 0 && elapsed <= ESCAPE_STOP_WINDOW_MS;
}
