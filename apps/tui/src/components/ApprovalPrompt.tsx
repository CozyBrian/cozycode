import { useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { PermissionReply, PermissionRequest } from "@cozycode/protocol";
import { shortPath, theme } from "../theme.ts";

interface Props {
  request: PermissionRequest;
  queueLength: number;
  onRespond: (reply: PermissionReply, message?: string) => void;
}

type Stage = "permission" | "always";
type Choice = PermissionReply;

export function ApprovalPrompt({ request, queueLength, onRespond }: Props) {
  const dimensions = useTerminalDimensions();
  const [stage, setStage] = useState<Stage>("permission");
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const choices: Choice[] = request.always.length > 0 ? ["once", "always", "reject"] : ["once", "reject"];
  const info = permissionInfo(request);

  const move = (direction: number) => {
    setSelected((current) => (current + direction + choices.length) % choices.length);
  };
  const submit = () => {
    const choice = choices[selected] ?? "reject";
    if (choice === "always") return setStage("always");
    onRespond(choice);
  };

  useKeyboard((key) => {
    if (stage === "always") {
      if (key.name === "escape") setStage("permission");
      if (key.name === "return" || key.name === "kpenter") onRespond("always");
      return;
    }
    if (key.ctrl && key.name === "f" && info.detail) {
      setExpanded((value) => !value);
      return;
    }
    if (key.name === "left" || key.name === "h") return move(-1);
    if (key.name === "right" || key.name === "l") return move(1);
    if (key.name === "return" || key.name === "kpenter") return submit();
    if (key.name === "escape") onRespond("reject");
  });

  if (stage === "always") {
    return (
      <box flexDirection="column" border={['left']} borderStyle="heavy" borderColor={theme.warning} backgroundColor={theme.panel}>
        <box flexDirection="column" paddingX={2} paddingY={1}>
          <text fg={theme.warning}>△ Always allow</text>
          <text fg={theme.muted}>This temporary rule lasts until the current session ends.</text>
          <box marginTop={1} flexDirection="column">
            {request.always.map((pattern) => <text key={pattern} fg={theme.text}>- {pattern}</text>)}
          </box>
        </box>
        <box flexDirection="row" justifyContent="space-between" backgroundColor={theme.element} paddingX={2} paddingY={1}>
          <text fg={theme.warning}>Enter confirm</text>
          <text fg={theme.muted}>esc cancel</text>
        </box>
      </box>
    );
  }

  const maxDetailLines = expanded ? Math.max(3, (dimensions.height || 24) - 9) : 5;
  return (
    <box
      flexDirection="column"
      border={['left']}
      borderStyle="heavy"
      borderColor={theme.warning}
      backgroundColor={theme.panel}
      position={expanded ? "absolute" : undefined}
      top={expanded ? 1 : undefined}
      bottom={expanded ? 1 : undefined}
      left={expanded ? 2 : undefined}
      right={expanded ? 2 : undefined}
      zIndex={expanded ? 100 : undefined}
    >
      <box flexDirection="column" flexGrow={expanded ? 1 : undefined} paddingX={2} paddingY={1}>
        <text fg={theme.warning}>△ Permission required{queueLength > 1 ? ` (${queueLength} pending)` : ""}</text>
        <text fg={theme.text}><span style={{ fg: theme.muted }}>{info.icon} </span>{info.title}</text>
        {info.detail ? (
          <scrollbox maxHeight={expanded ? undefined : maxDetailLines} flexGrow={expanded ? 1 : undefined} marginTop={1}>
            {info.detail.split("\n").slice(0, expanded ? undefined : maxDetailLines).map((line, index) => (
              <text key={`${index}:${line}`} fg={info.isCommand ? theme.text : theme.muted}>{line}</text>
            ))}
          </scrollbox>
        ) : null}
      </box>
      <box flexDirection="row" justifyContent="space-between" backgroundColor={theme.element} paddingX={2} paddingY={1}>
        <box flexDirection="row">
          {choices.map((choice, index) => (
            <text key={choice} bg={index === selected ? theme.warning : undefined} fg={index === selected ? theme.bg : theme.muted}>
              {` ${choiceLabel(choice)} `}
            </text>
          ))}
        </box>
        <text fg={theme.muted}>{info.detail ? "ctrl+f details · " : ""}←→ select · enter confirm</text>
      </box>
    </box>
  );
}

function choiceLabel(choice: Choice): string {
  if (choice === "once") return "Allow once";
  if (choice === "always") return "Allow always";
  return "Reject";
}

function permissionInfo(request: PermissionRequest): { icon: string; title: string; detail: string; isCommand?: boolean } {
  const metadata = request.metadata;
  const text = (key: string) => typeof metadata[key] === "string" ? metadata[key] : "";
  const resource = text("path") || text("filepath") || request.patterns[0] || "";
  const summary = text("summary");
  const command = text("command");
  const diff = text("diff");

  if (request.permission === "edit") {
    return { icon: "→", title: `Edit ${shortPath(resource)}`, detail: diff || summary || resource };
  }
  if (request.permission === "bash" || request.permission === "shell") {
    return { icon: "$", title: "Run shell command", detail: command || summary || request.patterns.join("\n"), isCommand: true };
  }
  if (request.permission === "read") return { icon: "→", title: `Read ${shortPath(resource)}`, detail: resource };
  if (request.permission === "glob" || request.permission === "search" || request.permission === "grep") {
    return { icon: "*", title: `Search ${text("pattern") || request.patterns[0] || "files"}`, detail: summary || request.patterns.join("\n") };
  }
  if (request.permission === "list") return { icon: "→", title: `List ${shortPath(resource)}`, detail: resource };
  if (request.permission === "webfetch") return { icon: "%", title: "Fetch URL", detail: text("url") || summary || request.patterns.join("\n") };
  return { icon: "⚙", title: `Use ${request.permission}`, detail: summary || request.patterns.join("\n") };
}
