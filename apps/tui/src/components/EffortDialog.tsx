import { DialogSelect } from "./DialogSelect.tsx";

interface Props {
  /** The model's ordered effort ladder (weakest → strongest). */
  efforts: string[];
  /** The currently-selected effort, or undefined for the provider default. */
  current: string | undefined;
  /** Called with the chosen level, or undefined to clear to the default. */
  onSelect: (level: string | undefined) => void;
  onCancel: () => void;
}

/** Reasoning-effort picker: "Default" plus the model's ladder levels. */
export function EffortDialog({ efforts, current, onSelect, onCancel }: Props) {
  return (
    <DialogSelect
      title="Reasoning effort"
      placeholder="Search levels…"
      options={[
        { value: undefined as string | undefined, title: "Default", current: !current },
        ...efforts.map((level) => ({ value: level, title: level, current: level === current })),
      ]}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}
