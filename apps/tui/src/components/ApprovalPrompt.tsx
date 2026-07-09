import type { SelectOption } from "@opentui/core";
import type { PermissionReply, PermissionRequest } from "@cozycode/protocol";
import { theme } from "../theme.ts";

interface Props {
  request: PermissionRequest;
  queueLength: number;
  onRespond: (reply: PermissionReply, message?: string) => void;
}

export function ApprovalPrompt({ request, queueLength, onRespond }: Props) {
  const summary = typeof request.metadata.summary === "string" ? request.metadata.summary : "";
  const detail = summary || request.patterns.join(", ");

  // The "always" label is dynamic (it names the grant), so options are per-request.
  const options: SelectOption[] = [
    { name: "Allow once", description: "Approve this action", value: "once" satisfies PermissionReply },
  ];
  if (request.always.length > 0) {
    options.push({
      name: `Always allow "${request.always.join('", "')}"`,
      description: "Grant this for the rest of the session",
      value: "always" satisfies PermissionReply,
    });
  }
  options.push({
    name: "Reject",
    description: "Block the action",
    value: "reject" satisfies PermissionReply,
  });

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
        △ Approve action?{queueLength > 1 ? ` (1 of ${queueLength})` : ""}
      </text>
      <text>
        <span style={{ fg: theme.accent }}>{request.permission}</span>
        <span style={{ fg: theme.muted }}> · {detail}</span>
      </text>
      <box marginTop={1} height={4}>
        <select
          focused
          options={options}
          textColor={theme.text}
          selectedTextColor={theme.bg}
          selectedBackgroundColor={theme.warning}
          descriptionColor={theme.muted}
          onSelect={(_index, option) => option?.value && onRespond(option.value as PermissionReply)}
        />
      </box>
    </box>
  );
}
