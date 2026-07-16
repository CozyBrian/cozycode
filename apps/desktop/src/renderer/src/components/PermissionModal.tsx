import { useState } from "react";
import type { PermissionReply, PermissionRequest } from "@cozycode/protocol";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

interface Props {
  request: PermissionRequest;
  queueLength: number;
  onReply: (reply: PermissionReply, message?: string) => void;
}

export function PermissionModal({ request, queueLength, onReply }: Props) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const shouldReduceMotion = useReducedMotion();
  const hidden = shouldReduceMotion
    ? { opacity: 0 }
    : { opacity: 0, transform: "translateY(-4px)" };

  const summary = typeof request.metadata.summary === "string" ? request.metadata.summary : "";
  const command =
    typeof request.metadata.command === "string" ? request.metadata.command : undefined;
  const canAlways = request.always.length > 0;
  const alwaysLabel = request.always.join('", "');

  const reject = () => onReply("reject", feedback.trim() ? feedback.trim() : undefined);

  return (
    <Dialog open onOpenChange={(next) => !next && onReply("reject")}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            Approve action?
            {queueLength > 1 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                1 of {queueLength} pending
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-primary">{request.permission}</span>
            {summary ? ` — ${summary}` : ""}
          </DialogDescription>
        </DialogHeader>

        <pre className="selectable max-h-64 overflow-auto rounded-lg border border-border bg-card/60 p-3 font-mono text-xs text-muted-foreground">
          {command ?? request.patterns.join("\n")}
        </pre>

        <AnimatePresence initial={false}>
          {showFeedback ? (
            <motion.textarea
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="Tell the model why, or what to do instead (optional)…"
              initial={hidden}
              animate={{ opacity: 1, transform: "translateY(0px)" }}
              exit={hidden}
              transition={{ duration: shouldReduceMotion ? 0.12 : 0.16, ease: [0.23, 1, 0.32, 1] }}
              className="min-h-20 w-full resize-y rounded-lg border border-border bg-card/60 p-2 font-mono text-xs text-foreground outline-none"
            />
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false} mode="popLayout">
          {showFeedback ? (
            <motion.div
              key="feedback-actions"
              initial={hidden}
              animate={{ opacity: 1, transform: "translateY(0px)" }}
              exit={hidden}
              transition={{ duration: shouldReduceMotion ? 0.12 : 0.16, ease: [0.23, 1, 0.32, 1] }}
              className="flex justify-end gap-2"
            >
              <Button variant="ghost" onClick={reject}>Send rejection</Button>
            </motion.div>
          ) : (
            <motion.div
              key="approval-actions"
              initial={hidden}
              animate={{ opacity: 1, transform: "translateY(0px)" }}
              exit={hidden}
              transition={{ duration: shouldReduceMotion ? 0.12 : 0.16, ease: [0.23, 1, 0.32, 1] }}
              className="flex justify-end gap-2"
            >
              <Button variant="ghost" onClick={() => setShowFeedback(true)}>
                Reject…
              </Button>
              {canAlways && (
                <Button variant="outline" onClick={() => onReply("always")}>
                  Always allow &quot;{alwaysLabel}&quot;
                </Button>
              )}
              <Button onClick={() => onReply("once")}>Allow once</Button>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}
