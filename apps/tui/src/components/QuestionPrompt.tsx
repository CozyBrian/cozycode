import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { QuestionRequest } from "@cozycode/protocol";
import { theme } from "../theme.ts";

interface Props {
  request: QuestionRequest;
  onAnswer: (answers: string[][]) => void;
  onReject: () => void;
}

const FREE_TEXT = "Type your own answer…";

/**
 * Inline blocker for the `ask_user` tool — steps through the request's questions
 * one at a time. Arrow keys move; space toggles (multi-select); enter selects /
 * confirms; the last row opens a free-text input; esc declines the whole ask.
 * Rendered in the same slot as `ApprovalPrompt`.
 */
export function QuestionPrompt({ request, onAnswer, onReject }: Props) {
  const [qIndex, setQIndex] = useState(0);
  const [collected, setCollected] = useState<string[][]>([]);
  const [selected, setSelected] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [freeOpen, setFreeOpen] = useState(false);
  const [freeValue, setFreeValue] = useState("");

  const question = request.questions[qIndex]!;
  const multiple = question.multiple ?? false;
  const rowCount = question.options.length + 1; // options + free-text row
  const freeRow = question.options.length;

  const reset = () => {
    setSelected(0);
    setChecked(new Set());
    setFreeOpen(false);
    setFreeValue("");
  };

  const advance = (answer: string[]) => {
    const next = [...collected];
    next[qIndex] = answer;
    if (qIndex === request.questions.length - 1) {
      onAnswer(next);
      return;
    }
    setCollected(next);
    setQIndex(qIndex + 1);
    reset();
  };

  const move = (direction: number) =>
    setSelected((current) => (current + direction + rowCount) % rowCount);

  const confirmMulti = () => {
    const labels = [...checked].sort((a, b) => a - b).map((i) => question.options[i]!.label);
    if (freeValue.trim()) labels.push(freeValue.trim());
    advance(labels);
  };

  useKeyboard((key) => {
    if (freeOpen) {
      if (key.name === "escape") return setFreeOpen(false);
      if (key.name === "return" || key.name === "kpenter") {
        const value = freeValue.trim();
        if (!value) return setFreeOpen(false);
        if (multiple) return setFreeOpen(false); // keep freeValue; confirm later
        return advance([value]);
      }
      return; // typing captured by the <input>
    }
    if (key.name === "escape") return onReject();
    if (key.name === "up" || key.name === "k") return move(-1);
    if (key.name === "down" || key.name === "j") return move(1);
    if (key.name === "space" && multiple && selected < question.options.length) {
      setChecked((current) => {
        const next = new Set(current);
        if (next.has(selected)) next.delete(selected);
        else next.add(selected);
        return next;
      });
      return;
    }
    if (key.name === "return" || key.name === "kpenter") {
      if (selected === freeRow) return setFreeOpen(true);
      if (multiple) return confirmMulti();
      return advance([question.options[selected]!.label]);
    }
  });

  return (
    <box flexDirection="column" border={["left"]} borderStyle="heavy" borderColor={theme.primary} backgroundColor={theme.panel}>
      <box flexDirection="column" paddingX={2} paddingY={1}>
        <text fg={theme.primary}>
          ? Question {qIndex + 1}/{request.questions.length}
          <span style={{ fg: theme.muted }}>{`  ${question.header}`}</span>
        </text>
        <text fg={theme.text}>{question.question}</text>
        <box marginTop={1} flexDirection="column">
          {question.options.map((option, index) => {
            const active = index === selected;
            const mark = multiple ? (checked.has(index) ? "◉ " : "○ ") : active ? "› " : "  ";
            return (
              <text key={`${index}:${option.label}`} fg={active ? theme.bg : theme.text} bg={active ? theme.primary : undefined}>
                {mark}
                {option.label}
                {option.description ? <span style={{ fg: active ? theme.bg : theme.muted }}>{`  ${option.description}`}</span> : ""}
              </text>
            );
          })}
          <text fg={selected === freeRow ? theme.bg : theme.muted} bg={selected === freeRow ? theme.primary : undefined}>
            {multiple ? (checked.size || freeValue ? "  " : "  ") : selected === freeRow ? "› " : "  "}
            {freeValue ? `✎ ${freeValue}` : FREE_TEXT}
          </text>
        </box>
        {freeOpen ? (
          <box flexDirection="row" marginTop={1}>
            <text fg={theme.primary}>{"✎ "}</text>
            <input focused placeholder="Type your answer, enter to confirm" onInput={(value: string) => setFreeValue(value)} />
          </box>
        ) : null}
      </box>
      <box flexDirection="row" justifyContent="space-between" backgroundColor={theme.element} paddingX={2} paddingY={1}>
        <text fg={theme.muted}>
          {multiple ? "space toggle · enter confirm" : "enter select"} · ↑↓ move · esc decline
        </text>
        <text fg={theme.muted}>{request.questions.length > 1 ? `${qIndex + 1} of ${request.questions.length}` : ""}</text>
      </box>
    </box>
  );
}
