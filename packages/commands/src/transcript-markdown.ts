/** Renderer-neutral transcript shape accepted by Markdown export. */
export interface MarkdownTranscriptItem {
  kind: "user" | "assistant" | "tool" | "reasoning" | "error" | "system";
  text?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  status?: string;
}

export function formatTranscriptMarkdown(title: string, items: readonly MarkdownTranscriptItem[]): string {
  const sections = [`# ${title}`];
  for (const item of items) {
    if (item.kind === "user") sections.push(`## User\n\n${item.text ?? ""}`);
    else if (item.kind === "assistant") sections.push(`## Assistant\n\n${item.text ?? ""}`);
    else if (item.kind === "reasoning") sections.push(`## Reasoning\n\n${item.text ?? ""}`);
    else if (item.kind === "error") sections.push(`## Error\n\n${item.text ?? ""}`);
    else if (item.kind === "system") sections.push(`> ${item.text ?? ""}`);
    else {
      const status = item.status ? ` (${item.status})` : "";
      const details = [
        item.args === undefined ? "" : `### Input\n\n\`\`\`json\n${json(item.args)}\n\`\`\``,
        item.result === undefined ? "" : `### Result\n\n\`\`\`json\n${json(item.result)}\n\`\`\``,
      ].filter(Boolean).join("\n\n");
      sections.push(`## Tool: ${item.toolName ?? "unknown"}${status}${details ? `\n\n${details}` : ""}`);
    }
  }
  return `${sections.join("\n\n")}\n`;
}

export function sessionMarkdownFilename(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return `${slug || "cozycode-session"}.md`;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}
