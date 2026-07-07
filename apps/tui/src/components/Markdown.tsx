import { theme } from "../theme.ts";

export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const lines = formatMarkdown(text);
  return (
    <box flexDirection="column">
      {lines.map((line, index) => (
        <text key={index} fg={line.kind === "code" ? theme.yellow : line.kind === "heading" ? theme.primary : theme.text}>
          {line.text || " "}
        </text>
      ))}
      {streaming ? <text fg={theme.muted}>▍</text> : null}
    </box>
  );
}

function formatMarkdown(input: string): { text: string; kind?: "heading" | "code" }[] {
  let inCode = false;
  return input.split("\n").map((raw) => {
    const trimmed = raw.trimEnd();
    if (trimmed.startsWith("```")) {
      inCode = !inCode;
      return { text: trimmed, kind: "code" };
    }
    if (inCode) return { text: raw, kind: "code" };
    if (trimmed.startsWith("#")) return { text: trimmed.replace(/^#+\s*/, ""), kind: "heading" };
    return {
      text: trimmed
        .replace(/^\s*[-*]\s+/, "• ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/_([^_]+)_/g, "$1"),
    };
  });
}
