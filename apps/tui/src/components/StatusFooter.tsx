import { shortPath, theme } from "../theme.ts";

interface Props {
  model: string;
  workspaceRoot: string;
  busy: boolean;
  approvals: number;
}

export function StatusFooter({ model, workspaceRoot, busy, approvals }: Props) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme.muted}>{shortPath(workspaceRoot)}</text>
      <text fg={theme.muted}>
        <span style={{ fg: busy ? theme.warning : theme.success }}>{busy ? "● working" : "○ ready"}</span>
        {" · "}{model}
        {approvals > 0 ? ` · △ ${approvals}` : ""}
      </text>
    </box>
  );
}
