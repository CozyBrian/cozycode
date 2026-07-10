import { z } from "zod";
import { defineTool } from "./types.ts";

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_TIMEOUT_MS = 120 * 1000;

export const webFetchTool = defineTool({
  name: "webfetch",
  description:
    "Fetch the contents of a URL over HTTP(S). Returns the page as markdown by " +
    "default (HTML is converted), or as plain text / raw html. Use it to read " +
    "documentation, articles, or API responses referenced in the task.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch (must start with http:// or https://)."),
    format: z
      .enum(["markdown", "text", "html"])
      .optional()
      .describe("Return format; defaults to markdown."),
    timeout: z.number().optional().describe("Timeout in seconds (max 120)."),
  }),
  summarize: ({ url }) => `Fetch ${url}`,
  async run({ url, format = "markdown", timeout }, ctx) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("URL must start with http:// or https://.");
    }
    const timeoutMs = Math.min((timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000, MAX_TIMEOUT_MS);
    const signal = AbortSignal.any(
      [ctx.abortSignal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => Boolean(s)),
    );

    const response = await fetch(url, {
      signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status} ${response.statusText}`);

    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_RESPONSE_BYTES) throw new Error("Response too large (exceeds 5MB limit).");

    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
      throw new Error("Response too large (exceeds 5MB limit).");
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const isHtml = contentType.includes("html") || /^\s*<(?:!doctype|html)/i.test(body);

    let content = body;
    if (isHtml && format === "markdown") content = htmlToMarkdown(body);
    else if (isHtml && format === "text") content = htmlToText(body);
    // format === "html", or non-HTML content: return as-is.

    ctx.reportMetadata?.({ url, format, title: `${url} (${contentType || "unknown"})` });
    return { url, format, content };
  },
});

/** Strip scripts/styles and tags, collapse whitespace — a dependency-free text extract. */
function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|iframe|template|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * Light HTML→markdown: preserves headings, links, list items, and paragraph
 * breaks, then falls through to the text extractor. Good enough for feeding a
 * page to the model without pulling in a full DOM/turndown dependency.
 */
function htmlToMarkdown(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|iframe|template|svg)[\s\S]*?<\/\1>/gi, "");
  const withMarks = cleaned
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n\n# ${strip(t)}\n\n`)
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n\n## ${strip(t)}\n\n`)
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n\n### ${strip(t)}\n\n`)
    .replace(/<h[456][^>]*>([\s\S]*?)<\/h[456]>/gi, (_m, t) => `\n\n#### ${strip(t)}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `\n- ${strip(t)}`)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => {
      const label = strip(t);
      return label ? `[${label}](${href})` : href;
    })
    .replace(/<(p|br|div|section|article|tr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|ul|ol|li|tr)>/gi, "\n");
  return htmlToText(withMarks);
}

function strip(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
