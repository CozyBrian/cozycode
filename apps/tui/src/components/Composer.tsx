import { Prompt } from "./Prompt.tsx";

interface Props {
  busy: boolean;
  /** Bump this to remount the input and clear it after a submit. */
  inputKey: number;
  model?: string;
  workspaceRoot?: string;
  onSubmit: (value: string) => void;
}

export function Composer({ busy, inputKey, model, workspaceRoot, onSubmit }: Props) {
  if (model && workspaceRoot) {
    return <Prompt busy={busy} inputKey={inputKey} model={model} workspaceRoot={workspaceRoot} onSubmit={onSubmit} />;
  }
  if (busy) {
    return (
      <box paddingX={1}>
        <text>working… (esc to interrupt)</text>
      </box>
    );
  }
  return (
    <box borderStyle="rounded" borderColor="cyan" paddingX={1}>
      <text fg="cyan">
        {"› "}
      </text>
      <input key={inputKey} focused placeholder="Describe a task…  (enter to send, ctrl+c to quit)" onSubmit={onSubmit as never} />
    </box>
  );
}
