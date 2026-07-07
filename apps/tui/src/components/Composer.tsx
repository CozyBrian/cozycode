import { Box, Text } from "ink";
import { TextInput, Spinner } from "@inkjs/ui";

interface Props {
  busy: boolean;
  /** Bump this to remount the input and clear it after a submit. */
  inputKey: number;
  onSubmit: (value: string) => void;
}

export function Composer({ busy, inputKey, onSubmit }: Props) {
  if (busy) {
    return (
      <Box paddingX={1}>
        <Spinner label="working… (esc to interrupt)" />
      </Box>
    );
  }
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {"› "}
      </Text>
      <TextInput key={inputKey} placeholder="Describe a task…  (enter to send, ctrl+c to quit)" onSubmit={onSubmit} />
    </Box>
  );
}
