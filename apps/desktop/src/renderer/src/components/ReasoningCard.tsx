import { Brain, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { TranscriptItem } from "../transcript.ts";
import { Markdown } from "../chat/Markdown.tsx";
import { TextShimmer } from "./TextShimmer";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

/**
 * A reasoning/thinking block: a collapsed, dimmed header the user can expand to
 * reveal the (muted) reasoning text. Mirrors opencode's collapsed thinking UI.
 */
export function ReasoningCard({ item }: { item: Extract<TranscriptItem, { kind: "reasoning" }> }) {
  const [open, setOpen] = useState(false);
  const { title, body } = splitSummary(item.text);
  const hasBody = body.trim().length > 0;
  const shouldReduceMotion = useReducedMotion();
  const header = item.streaming
    ? title ?? "Thinking…"
    : `Thought${title ? ` · ${title}` : ""}${duration(item.durationMs)}`;

  return (
    <section className="text-muted-foreground">
      <button
        type="button"
        onClick={() => hasBody && setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 text-sm",
          hasBody && "cursor-pointer hover:text-foreground/80",
        )}
      >
        <Brain className="size-3.5 shrink-0 opacity-70" />
        {item.streaming ? <TextShimmer className="text-sm">{header}</TextShimmer> : <span>{header}</span>}
        {hasBody && (
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        )}
      </button>
      <AnimatePresence initial={false}>
        {open && hasBody ? (
          <motion.div
            initial={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, transform: "translateY(-4px)" }}
            animate={{ opacity: 0.7, transform: "translateY(0px)" }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, transform: "translateY(-4px)" }}
            transition={{ duration: shouldReduceMotion ? 0.12 : 0.16, ease: [0.23, 1, 0.32, 1] }}
            className="mt-2 border-l border-white/10 pl-3 text-sm"
          >
            <Markdown text={body} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

/** Whole-seconds duration suffix, e.g. " for 12s"; empty when unknown. */
function duration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ` for ${Math.max(1, Math.round(ms / 1000))}s`;
}

/** Split a leading `**Title**` summary line from the body (OpenAI Responses style). */
function splitSummary(text: string): { title?: string; body: string } {
  const match = text.match(/^\s*\*\*(.+?)\*\*\s*\n?/);
  if (!match) return { body: text };
  return { title: match[1]!.trim(), body: text.slice(match[0].length) };
}
