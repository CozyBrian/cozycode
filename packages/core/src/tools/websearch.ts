import { z } from "zod";
import { defineTool } from "./types.ts";

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

type Provider = "exa" | "tavily" | "brave";

/** Pick a backend: explicit override, else whichever API key is present. */
function selectProvider(): Provider | undefined {
  const override = process.env.COZY_WEBSEARCH_PROVIDER;
  if (override === "exa" || override === "tavily" || override === "brave") return override;
  if (process.env.EXA_API_KEY) return "exa";
  if (process.env.TAVILY_API_KEY) return "tavily";
  if (process.env.BRAVE_API_KEY) return "brave";
  return undefined;
}

export const webSearchTool = defineTool({
  name: "websearch",
  description:
    "Search the web and return ranked results (title, URL, snippet). Use it to " +
    "find current information, documentation, or sources, then `webfetch` a " +
    "result URL for the full content.",
  inputSchema: z.object({
    query: z.string().describe("The search query."),
    numResults: z.number().optional().describe("Number of results to return (default 8)."),
  }),
  summarize: ({ query }) => `Search the web for "${query}"`,
  async run({ query, numResults = 8 }, ctx) {
    const provider = selectProvider();
    if (!provider) {
      throw new Error(
        "Web search is not configured. Set one of EXA_API_KEY, TAVILY_API_KEY, or BRAVE_API_KEY " +
          "(optionally COZY_WEBSEARCH_PROVIDER to choose between them).",
      );
    }
    const results = await search(provider, query, numResults, ctx.abortSignal);
    ctx.reportMetadata?.({ query, provider, results });
    if (results.length === 0) return { query, provider, results: "No results found." };
    const text = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
      .join("\n\n");
    return { query, provider, results: text };
  },
});

async function search(
  provider: Provider,
  query: string,
  numResults: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const timeout = AbortSignal.timeout(25_000);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;

  if (provider === "exa") {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      signal: merged,
      headers: { "content-type": "application/json", "x-api-key": process.env.EXA_API_KEY! },
      body: JSON.stringify({ query, numResults, contents: { text: { maxCharacters: 800 } } }),
    });
    if (!res.ok) throw new Error(`Exa search failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; text?: string }> };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? r.url ?? "",
      url: r.url ?? "",
      snippet: r.text?.slice(0, 500),
    }));
  }

  if (provider === "tavily") {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: merged,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, max_results: numResults }),
    });
    if (!res.ok) throw new Error(`Tavily search failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? r.url ?? "",
      url: r.url ?? "",
      snippet: r.content,
    }));
  }

  // brave
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(numResults));
  const res = await fetch(url, {
    signal: merged,
    headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY! },
  });
  if (!res.ok) throw new Error(`Brave search failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title ?? r.url ?? "",
    url: r.url ?? "",
    snippet: r.description,
  }));
}
