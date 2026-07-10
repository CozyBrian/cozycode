import { cn } from "@/lib/utils";

interface Props {
  /** Number of lit bars (0 = none). */
  filled: number;
  /** Total bars to draw (the model's ladder length). */
  total: number;
  className?: string;
}

/**
 * A cellular-signal-style effort meter: `total` bars of increasing height,
 * `filled` of them lit. Bar count is per-model (the ladder length), so a level's
 * position reads as signal strength — 1/3 for a low, 3/3 for a high. Inherits
 * `currentColor`, so the parent sets lit/dim via text color + opacity.
 */
export function EffortBars({ filled, total, className }: Props) {
  const barW = 2.5;
  const gap = 1.5;
  const minH = 3;
  const maxH = 11;
  const width = total * barW + (total - 1) * gap;

  return (
    <svg
      width={width}
      height={maxH}
      viewBox={`0 0 ${width} ${maxH}`}
      fill="none"
      className={cn("shrink-0", className)}
      aria-hidden
    >
      {Array.from({ length: total }, (_, i) => {
        const h = total === 1 ? maxH : minH + (maxH - minH) * (i / (total - 1));
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={maxH - h}
            width={barW}
            height={h}
            rx={1}
            fill="currentColor"
            opacity={i < filled ? 1 : 0.25}
          />
        );
      })}
    </svg>
  );
}
