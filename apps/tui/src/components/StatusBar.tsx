import { Box, Text } from "ink";

interface Props {
  model: string;
  workspaceRoot: string;
  busy: boolean;
}

export function StatusBar({ model, workspaceRoot, busy }: Props) {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">
        cozycode
      </Text>
      <Text color="gray">
        {model} · {shortenPath(workspaceRoot)}
      </Text>
      <Text color={busy ? "yellow" : "green"}>{busy ? "● working" : "○ ready"}</Text>
    </Box>
  );
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : p;
}
