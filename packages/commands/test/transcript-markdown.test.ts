import { describe, expect, test } from "bun:test";
import { formatTranscriptMarkdown, sessionMarkdownFilename } from "../src/transcript-markdown.ts";

describe("Markdown transcript export", () => {
  test("preserves conversation and tool details", () => {
    expect(formatTranscriptMarkdown("Build notes", [
      { kind: "user", text: "Add export" },
      { kind: "assistant", text: "I will add it." },
      { kind: "tool", toolName: "write_file", status: "done", args: { path: "a.ts" }, result: { ok: true } },
    ])).toBe(`# Build notes

## User

Add export

## Assistant

I will add it.

## Tool: write_file (done)

### Input

\`\`\`json
{
  "path": "a.ts"
}
\`\`\`

### Result

\`\`\`json
{
  "ok": true
}
\`\`\`
`);
  });

  test("derives a safe Markdown filename", () => {
    expect(sessionMarkdownFilename("Fix: parser / export")).toBe("fix-parser-export.md");
  });
});
