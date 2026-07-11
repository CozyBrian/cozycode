import { useState } from "react";
import { Check, Copy, ExternalLink, LoaderCircle, Plus, Unplug } from "lucide-react";
import type { CustomProviderInput, OAuthStart, ProviderInfo, ProviderList } from "@cozycode/protocol";
import { useApp } from "../../store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function apply(list: ProviderList): void {
  useApp.setState({ providers: list });
}

function ApiKeyForm({ provider, onDone }: { provider: ProviderInfo; onDone(): void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="mt-3 flex gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError(null);
        try {
          apply(await window.cozy.providers.connectApi(provider.id, key));
          onDone();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setSaving(false);
        }
      }}
    >
      <div className="min-w-0 flex-1">
        <Input
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={provider.source === "custom" ? "API key (optional)" : `${provider.name} API key`}
          autoFocus
        />
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
      <Button type="submit" disabled={(provider.source !== "custom" && !key.trim()) || saving}>{saving ? "Saving…" : "Save"}</Button>
      <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
    </form>
  );
}

function ConnectCard({ provider, onDone }: { provider: ProviderInfo; onDone(): void }) {
  const [api, setApi] = useState(false);
  const [waiting, setWaiting] = useState<{ start: OAuthStart; method: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (api) return <ApiKeyForm provider={provider} onDone={() => setApi(false)} />;
  if (waiting) {
    return (
      <div className="mt-4 border-y border-border/60 py-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <LoaderCircle className="size-4 animate-spin" /> Waiting for authorization…
        </div>
        {waiting.start.deviceCode && (
          <div className="my-3 select-all font-mono text-2xl font-semibold tracking-widest">
            {waiting.start.deviceCode}
          </div>
        )}
        {waiting.start.instructions && <p className="mt-2 text-xs text-muted-foreground">{waiting.start.instructions}</p>}
        <p className="mt-2 select-all break-all text-xs text-muted-foreground">{waiting.start.url}</p>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <div className="mt-3 flex gap-2">
          <Button type="button" variant="outline" onClick={() => void window.cozy.providers.openExternal(waiting.start.url)}>
            <ExternalLink className="size-4" /> Open again
          </Button>
          {waiting.start.deviceCode && (
            <Button type="button" variant="ghost" onClick={() => void navigator.clipboard.writeText(waiting.start.deviceCode!)}>
              <Copy className="size-4" /> Copy code
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => {
            void window.cozy.providers.oauthCancel(provider.id, waiting.start.attemptID);
            setWaiting(null);
          }}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {provider.authMethods.map((method, index) => (
        <Button
          key={`${method.type}:${index}`}
          type="button"
          variant="outline"
          onClick={async () => {
            setError(null);
            if (method.type === "api") return setApi(true);
            try {
              const start = await window.cozy.providers.oauthStart(provider.id, index);
              setWaiting({ start, method: index });
              const result = await window.cozy.providers.oauthWait(provider.id, start.attemptID);
              if (result.status === "complete") {
                apply(await window.cozy.providers.list());
                onDone();
              } else if (result.status === "failed") {
                setError(result.message || "Authorization failed.");
              } else {
                setWaiting(null);
              }
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}
        >
          {method.label}
        </Button>
      ))}
      <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
      {error && <p className="w-full text-xs text-destructive">{error}</p>}
    </div>
  );
}

function CustomProviderForm({ onDone }: { onDone(): void }) {
  const [draft, setDraft] = useState<CustomProviderInput>({ id: "", name: "", baseURL: "", apiKey: "", models: [] });
  const [models, setModels] = useState("");
  const [error, setError] = useState<string | null>(null);
  const validID = /^[a-z0-9][a-z0-9-_]*$/.test(draft.id);
  return (
    <form
      className="mt-5 grid gap-3 border-y border-border/60 py-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!validID) return setError("Use lowercase letters, numbers, hyphens, or underscores.");
        try {
          apply(await window.cozy.providers.addCustom({
            ...draft,
            models: models.split("\n").map((item) => item.trim()).filter(Boolean),
          }));
          onDone();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }}
    >
      <div>
        <h3 className="text-sm font-medium">Custom provider</h3>
        <p className="text-xs text-muted-foreground">Any OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter…)</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="provider-id" />
        <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Display name (optional)" />
      </div>
      <Input value={draft.baseURL} onChange={(event) => setDraft({ ...draft, baseURL: event.target.value })} placeholder="http://localhost:11434/v1" />
      <Input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder="API key (optional)" />
      <textarea
        value={models}
        onChange={(event) => setModels(event.target.value)}
        placeholder="Models, one per line (optional)"
        className="min-h-24 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" disabled={!validID || !draft.baseURL}>Add provider</Button>
      </div>
    </form>
  );
}

export function ProvidersSection() {
  const providers = useApp((state) => state.providers);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const sorted = [...(providers?.all ?? [])]
    .filter((provider) => `${provider.name} ${provider.id}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => {
      const connected = Number(providers?.connected.includes(b.id)) - Number(providers?.connected.includes(a.id));
      return connected || a.name.localeCompare(b.name);
    });
  return (
    <section>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Model providers</h2>
          <p className="mt-1 text-xs text-muted-foreground">Credentials are stored in ~/.config/cozycode/auth.json.</p>
        </div>
        <Button variant="outline" onClick={() => setAdding(true)}><Plus className="size-4" /> Add custom</Button>
      </div>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search providers…"
        className="mb-3"
      />
      <div className="border-y border-border/70">
        {sorted.map((provider) => {
          const connected = providers?.connected.includes(provider.id) ?? false;
          return (
            <div key={provider.id} className="border-b border-border/60 py-4 last:border-b-0">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium">{provider.name}</span>
                    {provider.source === "custom" && <span className="text-muted-foreground">Custom</span>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {connected ? <><Check className="mr-1 inline size-3 text-emerald-400" />Connected</> : "Not connected"}
                    <span className="mx-1.5">/</span>{provider.models.length} models
                  </p>
                </div>
                {connected ? (
                  <Button variant="ghost" onClick={async () => apply(await window.cozy.providers.disconnect(provider.id))}>
                    <Unplug className="size-4" /> Disconnect
                  </Button>
                ) : (
                  <Button variant="outline" onClick={() => setConnecting(provider.id)}>Connect</Button>
                )}
              </div>
              {connecting === provider.id && <ConnectCard provider={provider} onDone={() => setConnecting(null)} />}
            </div>
          );
        })}
      </div>
      {adding && <CustomProviderForm onDone={() => setAdding(false)} />}
    </section>
  );
}
