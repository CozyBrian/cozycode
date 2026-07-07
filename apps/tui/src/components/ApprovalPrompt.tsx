import type { SelectOption } from "@opentui/core";
import type { ApprovalOutcome, ApprovalRequest } from "@cozycode/protocol";
import { theme } from "../theme.ts";

interface Props {
  request: ApprovalRequest;
  onRespond: (outcome: ApprovalOutcome) => void;
}

const OPTIONS: SelectOption[] = [
  { name: "Allow once", description: "Approve this action", value: "allow-once" satisfies ApprovalOutcome },
  { name: "Always allow", description: "Approve this tool for this session", value: "allow-session" satisfies ApprovalOutcome },
  { name: "Deny", description: "Block the action", value: "deny" satisfies ApprovalOutcome },
];

export function ApprovalPrompt({ request, onRespond }: Props) {
  return (
    <box
      flexDirection="column"
      borderStyle="heavy"
      borderColor={theme.warning}
      border={["left"]}
      backgroundColor={theme.element}
      paddingLeft={2}
      paddingY={1}
    >
      <text fg={theme.warning}>
        △ Approve action?
      </text>
      <text>
        <span style={{ fg: theme.accent }}>{request.toolName}</span>
        <span style={{ fg: theme.muted }}> · {request.summary}</span>
      </text>
      <box marginTop={1} height={4}>
        <select
          focused
          options={OPTIONS}
          textColor={theme.text}
          selectedTextColor={theme.bg}
          selectedBackgroundColor={theme.warning}
          descriptionColor={theme.muted}
          onSelect={(_index, option) => option?.value && onRespond(option.value as ApprovalOutcome)}
        />
      </box>
    </box>
  );
}
