import { useApp } from "../store/app-store";
import { compactTokens, compactTokensAlways } from "@/lib/format";
import { estimateContext } from "./context-estimate";

function projectLabel(root: string | null | undefined): string {
  if (!root) return "This chat";
  const parts = root.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground/90">{value}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

export function OverviewPane() {
  const sessions = useApp((s) => s.sessions);
  const activeId = useApp((s) => s.activeId);
  const model = useApp((s) => s.model);
  const effort = useApp((s) => s.effort);
  const providers = useApp((s) => s.providers);
  const preset = useApp((s) => s.preset);
  const turnUsage = useApp((s) => s.turnUsage);
  const sessionUsage = useApp((s) => s.sessionUsage);
  const items = useApp((s) => s.items);

  const meta = sessions.find((s) => s.id === activeId);
  const provider = providers?.all.find((p) => p.id === model?.providerID);
  const modelInfo = provider?.models.find((m) => m.id === model?.modelID);

  const contextWindow = modelInfo?.contextWindow;
  const inputTokens = turnUsage?.inputTokens ?? 0;
  const pct = contextWindow ? Math.min(100, Math.round((inputTokens / contextWindow) * 100)) : null;

  const estimate = estimateContext(items);

  const title =
    meta && !meta.title.startsWith("New session - ") ? meta.title : "Untitled session";
  const created = meta ? new Date(meta.createdAt).toLocaleString() : "—";

  return (
    <div className="flex flex-col gap-6 p-4">
      <section>
        <SectionTitle>Session</SectionTitle>
        <div className="flex flex-col gap-1.5">
          <Row label="Title" value={title} />
          <Row label="Project" value={projectLabel(meta?.workspaceRoot)} />
          <Row
            label="Model"
            value={modelInfo?.name ?? model?.modelID ?? "—"}
          />
          {effort ? <Row label="Effort" value={effort} /> : null}
          <Row label="Mode" value={preset} />
          <Row label="Turns" value={meta?.messageCount ?? 0} />
          <Row label="Created" value={created} />
        </div>
      </section>

      <section>
        <SectionTitle>Context</SectionTitle>
        {pct !== null ? (
          <div className="mb-3">
            <div className="mb-1 flex items-baseline justify-between text-sm">
              <span className="text-foreground/90">
                {compactTokensAlways(inputTokens)} / {compactTokens(contextWindow)}
              </span>
              <span className="text-muted-foreground">{pct}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        ) : (
          <p className="mb-3 text-sm text-muted-foreground">
            Run a turn to measure context usage.
          </p>
        )}

        {estimate.categories.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {estimate.categories.map((c) => (
              <Row key={c.label} label={c.label} value={`~${compactTokensAlways(c.tokens)}`} />
            ))}
            <p className="mt-1 text-xs text-muted-foreground/70">
              Estimated (~4 chars/token); excludes the system prompt and won't match
              measured totals.
            </p>
          </div>
        ) : null}
      </section>

      <section>
        <SectionTitle>Tokens</SectionTitle>
        <div className="flex flex-col gap-1.5">
          <Row
            label="Last turn"
            value={
              turnUsage
                ? `↑ ${compactTokensAlways(turnUsage.inputTokens ?? 0)}  ↓ ${compactTokensAlways(turnUsage.outputTokens ?? 0)}`
                : "—"
            }
          />
          <Row
            label="Session"
            value={`↑ ${compactTokensAlways(sessionUsage.inputTokens)}  ↓ ${compactTokensAlways(sessionUsage.outputTokens)}`}
          />
          <Row label="Session total" value={compactTokensAlways(sessionUsage.totalTokens)} />
          <p className="mt-1 text-xs text-muted-foreground/70">
            Session totals include subagent turns.
          </p>
        </div>
      </section>
    </div>
  );
}
