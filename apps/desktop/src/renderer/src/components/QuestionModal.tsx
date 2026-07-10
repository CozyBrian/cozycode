import { useState } from "react";
import type { QuestionRequest } from "@cozycode/protocol";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  request: QuestionRequest;
  onAnswer: (answers: string[][]) => void;
  onReject: () => void;
}

/**
 * Steps through the model's `ask_user` questions one at a time in the same
 * dialog (radio groups for single-select, checkboxes for multi-select, plus a
 * free-text field). Answers accumulate; the last step submits all of them.
 */
export function QuestionModal({ request, onAnswer, onReject }: Props) {
  const [step, setStep] = useState(0);
  // selected[q] = set of chosen option labels; free[q] = typed answer.
  const [selected, setSelected] = useState<Set<string>[]>(() => request.questions.map(() => new Set()));
  const [free, setFree] = useState<string[]>(() => request.questions.map(() => ""));

  const total = request.questions.length;
  const question = request.questions[step]!;
  const multiple = question.multiple ?? false;
  const isLast = step === total - 1;

  const toggle = (label: string) => {
    setSelected((prev) => {
      const next = prev.map((s) => new Set(s));
      const set = next[step]!;
      if (multiple) {
        if (set.has(label)) set.delete(label);
        else set.add(label);
      } else {
        next[step] = new Set([label]);
      }
      return next;
    });
  };

  const canAdvance = selected[step]!.size > 0 || free[step]!.trim().length > 0;

  const advance = () => {
    if (!isLast) {
      setStep(step + 1);
      return;
    }
    const answers = request.questions.map((_, q) => {
      const chosen = [...selected[q]!];
      const typed = free[q]!.trim();
      if (typed) chosen.push(typed);
      return chosen;
    });
    onAnswer(answers);
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onReject()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            The assistant has a question
            {total > 1 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {step + 1} of {total}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>Answer to continue, or dismiss to decline.</DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[60vh] flex-col gap-2 overflow-auto">
          <p className="text-sm font-medium text-foreground">{question.question}</p>
          <div className="flex flex-col gap-1.5">
            {question.options.map((option) => {
              const active = selected[step]!.has(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => toggle(option.label)}
                  className={cn(
                    "flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                    active
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border bg-card/40 text-muted-foreground hover:bg-white/5",
                  )}
                >
                  <span className="mt-0.5 text-primary">
                    {multiple ? (active ? "☑" : "☐") : active ? "◉" : "○"}
                  </span>
                  <span className="flex-1">
                    {option.label}
                    {option.description && (
                      <span className="block text-xs text-muted-foreground">{option.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          <input
            value={free[step]}
            onChange={(e) => setFree((prev) => prev.map((v, i) => (i === step ? e.target.value : v)))}
            placeholder="Or type your own answer…"
            className="w-full rounded-lg border border-border bg-card/60 px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onReject}>
            Dismiss
          </Button>
          {step > 0 && (
            <Button variant="outline" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          <Button disabled={!canAdvance} onClick={advance}>
            {isLast ? "Submit" : "Next"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
