import type { AgentMode } from "@cozycode/protocol";
import { shortPath, theme } from "../theme.ts";

interface Props {
  modelLabel: string;
  mode: AgentMode;
  workspaceRoot: string;
  busy: boolean;
  approvals: number;
}

export function StatusFooter({ modelLabel, mode, workspaceRoot, busy, approvals }: Props) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme.muted}>{shortPath(workspaceRoot)}</text>
      <text fg={theme.muted}>
        <span style={{ fg: busy ? theme.warning : theme.success }}>{busy ? "● working" : "○ ready"}</span>
        {" · "}
        {mode === "plan" ? (
          <span style={{ fg: theme.accent }}>PLAN</span>
        ) : (
          <span style={{ fg: theme.success }}>BUILD</span>
        )}
        {" · "}{modelLabel}
        {approvals > 0 ? ` · △ ${approvals}` : ""}
      </text>
    </box>
  );
}
