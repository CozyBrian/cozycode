import { Box, Text } from "ink";
import { Select } from "@inkjs/ui";
import type { ApprovalOutcome, ApprovalRequest } from "@cozycode/protocol";

interface Props {
  request: ApprovalRequest;
  onRespond: (outcome: ApprovalOutcome) => void;
}

const OPTIONS = [
  { label: "Allow once", value: "allow-once" },
  { label: "Always allow this tool", value: "allow-session" },
  { label: "Deny", value: "deny" },
];

export function ApprovalPrompt({ request, onRespond }: Props) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Approve action?
      </Text>
      <Text>
        <Text bold color="magenta">
          {request.toolName}
        </Text>
        <Text color="gray"> — {request.summary}</Text>
      </Text>
      <Box marginTop={1}>
        <Select options={OPTIONS} onChange={(v) => onRespond(v as ApprovalOutcome)} />
      </Box>
    </Box>
  );
}
