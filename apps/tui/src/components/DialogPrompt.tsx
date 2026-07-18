import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { theme } from "../theme.ts";

interface Props {
  title: string;
  label?: string;
  placeholder?: string;
  hint?: string;
  initialValue?: string;
  allowEmpty?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function DialogPrompt({
  title,
  label,
  placeholder,
  hint,
  initialValue = "",
  allowEmpty = false,
  onSubmit,
  onCancel,
}: Props) {
  const [value, setValue] = useState(initialValue);

  useKeyboard((key) => {
    if (key.name === "escape") {
      key.preventDefault();
      key.stopPropagation();
      onCancel();
    }
    if ((key.name === "return" || key.name === "kpenter") && (allowEmpty || value.trim())) {
      key.preventDefault();
      key.stopPropagation();
      onSubmit(value);
    }
  });

  return (
    <box justifyContent="center" marginY={1}>
      <box
        flexDirection="column"
        width={60}
        borderStyle="rounded"
        borderColor={theme.borderActive}
        backgroundColor={theme.panel}
        paddingX={2}
        paddingY={1}
      >
        <text fg={theme.text}>{title}</text>
        {label ? <text fg={theme.muted}>{label}</text> : null}
        <box flexDirection="row" marginTop={1}>
          <text fg={theme.primary}>{"› "}</text>
          <input
            focused
            value={value}
            placeholder={placeholder}
            onInput={setValue}
          />
        </box>
        {hint ? <text fg={theme.warning}>{hint}</text> : null}
        <text fg={theme.muted}>enter confirm · esc cancel</text>
      </box>
    </box>
  );
}
