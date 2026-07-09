import { useState } from "react";
import { Check, Plus, Unplug } from "lucide-react";
import type { CustomProviderInput, ProviderInfo, ProviderList } from "@cozycode/protocol";
import { useApp } from "../../store/app-store";
import { Badge } from "@/components/ui/badge";
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

function CustomProviderForm({ onDone }: { onDone(): void }) {
  const [draft, setDraft] = useState<CustomProviderInput>({ id: "", name: "", baseURL: "", apiKey: "", models: [] });
  const [models, setModels] = useState("");
  const [error, setError] = useState<string | null>(null);
  const validID = /^[a-z0-9][a-z0-9-_]*$/.test(draft.id);
  return (
    <form
      className="mt-4 grid gap-3 rounded-xl border border-border/70 bg-white/3 p-4"
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
  const sorted = [...(providers?.all ?? [])].sort((a, b) =>
    Number(providers?.connected.includes(b.id)) - Number(providers?.connected.includes(a.id)),
  );
  return (
    <section className="rounded-2xl border border-border/70 bg-white/3 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Model providers</h2>
          <p className="mt-1 text-xs text-muted-foreground">Credentials are stored in ~/.config/cozycode/auth.json.</p>
        </div>
        <Button variant="outline" onClick={() => setAdding(true)}><Plus className="size-4" /> Add custom</Button>
      </div>
      <div className="grid gap-2">
        {sorted.map((provider) => {
          const connected = providers?.connected.includes(provider.id) ?? false;
          return (
            <div key={provider.id} className="rounded-xl border border-border/70 px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{provider.name}</span>
                    {provider.source === "custom" && <Badge variant="outline">Custom</Badge>}
                    <Badge variant={connected ? "secondary" : "outline"} className={connected ? "text-emerald-400" : ""}>
                      {connected ? <><Check className="size-3" /> Connected</> : "Not connected"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{provider.models.length} models</p>
                </div>
                {connected ? (
                  <Button variant="ghost" onClick={async () => apply(await window.cozy.providers.disconnect(provider.id))}>
                    <Unplug className="size-4" /> Disconnect
                  </Button>
                ) : (
                  <Button variant="outline" onClick={() => setConnecting(provider.id)}>Connect</Button>
                )}
              </div>
              {connecting === provider.id && <ApiKeyForm provider={provider} onDone={() => setConnecting(null)} />}
            </div>
          );
        })}
      </div>
      {adding && <CustomProviderForm onDone={() => setAdding(false)} />}
    </section>
  );
}
