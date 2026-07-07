import { StatusFooter } from "./StatusFooter.tsx";

interface Props {
  model: string;
  workspaceRoot: string;
  busy: boolean;
  approvals?: number;
}

export function StatusBar({ model, workspaceRoot, busy, approvals }: Props) {
  if (approvals !== undefined) return <StatusFooter model={model} workspaceRoot={workspaceRoot} busy={busy} approvals={approvals} />;
  return (
    <box borderStyle="rounded" borderColor="gray" paddingX={1} justifyContent="space-between">
      <text fg="cyan">
        cozycode
      </text>
      <text fg="gray">
        {model} · {shortenPath(workspaceRoot)}
      </text>
      <text fg={busy ? "yellow" : "green"}>{busy ? "● working" : "○ ready"}</text>
    </box>
  );
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : p;
}
