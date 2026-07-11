import { isValidElement, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/github-dark.css";

const components: Components = {
  a: ({ children, ...props }) => (
    <a
      {...props}
      className="font-medium text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:text-cozy-300"
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-primary/50 pl-4 text-muted-foreground">
      {children}
    </blockquote>
  ),
  code: ({ className, children, ...props }) => (
    <code
      {...props}
      className={
        className
          ? `${className} font-mono text-[13px]`
          : "rounded-md bg-white/10 px-1.5 py-0.5 font-mono text-[13px] text-cozy-100"
      }
    >
      {children}
    </code>
  ),
  h1: ({ children }) => <h1 className="mb-3 mt-5 text-2xl font-semibold tracking-tight">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2.5 mt-5 text-xl font-semibold tracking-tight">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-4 text-lg font-semibold tracking-tight">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-2 mt-4 font-semibold tracking-tight">{children}</h4>,
  hr: () => <hr className="my-5 border-border" />,
  li: ({ children }) => <li className="pl-1 marker:text-muted-foreground">{children}</li>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>,
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  td: ({ children }) => <td className="border-t border-border px-3 py-2 align-top">{children}</td>,
  th: ({ children }) => (
    <th className="bg-white/5 px-3 py-2 text-left font-semibold text-foreground">{children}</th>
  ),
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>,
};

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = textContent(children);

  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="group relative my-3">
      <pre className="overflow-x-auto rounded-xl border border-border bg-black/35 p-4 text-[13px] leading-relaxed shadow-inner shadow-black/20">
        {children}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-white/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        aria-label="Copy code"
        title="Copy code"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return "";
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown selectable text-[15px] leading-relaxed text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
