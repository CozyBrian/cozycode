import { useEffect, useState } from "react";
import { Check, ChevronRight, FolderOpen, KeyRound, Palette, Shield, SlidersHorizontal, TerminalSquare, X } from "lucide-react";
import type { AppSettingsInput } from "../../../shared/ipc.ts";
import { useApp } from "../store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const sections = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "provider", label: "Provider", icon: KeyRound },
  { id: "workspace", label: "Workspace", icon: FolderOpen },
  { id: "permissions", label: "Permissions", icon: Shield },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "advanced", label: "Advanced", icon: TerminalSquare },
] as const;

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="flex items-center gap-2 font-medium text-foreground">
        {label}
        {hint}
      </span>
      {children}
    </label>
  );
}

function PlaceholderSetting({
  title,
  description,
  enabled,
}: {
  title: string;
  description: string;
  enabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border/70 bg-white/[0.03] px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        <div className="text-xs leading-relaxed text-muted-foreground">{description}</div>
      </div>
      <div
        className={cn(
          "flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors",
          enabled ? "justify-end bg-primary" : "justify-start bg-white/12",
        )}
      >
        <div className="size-4 rounded-full bg-white shadow-sm" />
      </div>
    </div>
  );
}

export function SettingsPage() {
  const initial = useApp((s) => s.settings);
  const closeSettings = useApp((s) => s.closeSettings);
  const setSettings = useApp((s) => s.setSettings);
  const bootstrap = useApp((s) => s.bootstrap);
  const [section, setSection] = useState<(typeof sections)[number]["id"]>("general");

  const configured = Boolean(initial?.baseURL && initial?.model && initial?.workspaceRoot);

  const [providerName, setProviderName] = useState(initial?.providerName ?? "openai-compatible");
  const [baseURL, setBaseURL] = useState(initial?.baseURL ?? "https://api.openai.com/v1");
  const [model, setModel] = useState(initial?.model ?? "");
  const [workspaceRoot, setWorkspaceRoot] = useState(initial?.workspaceRoot ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setProviderName(initial?.providerName ?? "openai-compatible");
    setBaseURL(initial?.baseURL ?? "https://api.openai.com/v1");
    setModel(initial?.model ?? "");
    setWorkspaceRoot(initial?.workspaceRoot ?? "");
    setApiKey("");
    setError(null);
  }, [initial]);

  const pick = async () => {
    const dir = await window.cozy.pickWorkspace();
    if (dir) setWorkspaceRoot(dir);
  };

  const save = async () => {
    setError(null);
    if (!baseURL || !model || !workspaceRoot) {
      setError("Base URL, model, and workspace folder are required.");
      return;
    }

    setSaving(true);
    try {
      const input: AppSettingsInput = { providerName, baseURL, model, workspaceRoot };
      if (apiKey) input.apiKey = apiKey;
      const saved = await window.cozy.saveSettings(input);
      const wasConfigured = configured;
      setSettings(saved);
      closeSettings();
      if (!wasConfigured) await bootstrap();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-screen min-h-0 flex-col bg-surface-content backdrop-blur-2xl">
      <header className="app-drag flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="min-w-0 truncate px-2 pl-28 text-sm font-medium text-foreground/85">
          Settings
        </div>
        <button
          type="button"
          onClick={closeSettings}
          className="app-no-drag flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full overflow-hidden">
          <aside className="w-64 shrink-0 border-r border-border/70 bg-sidebar/80 p-3 backdrop-blur-2xl">
            <div className="mb-3 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Configure
            </div>
            <nav className="flex flex-col gap-1">
              {sections.map((item) => {
                const Icon = item.icon;
                const active = item.id === section;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSection(item.id)}
                    className={cn(
                      "app-no-drag flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors",
                      active
                        ? "bg-white/10 text-foreground"
                        : "text-muted-foreground hover:bg-white/6 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {active && <ChevronRight className="size-3.5" />}
                  </button>
                );
              })}
            </nav>
          </aside>

          <main className="min-w-0 flex-1 overflow-y-auto p-6">
            <div className="max-w-3xl">
              <div className="mb-6">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Manage provider, workspace, permissions, and interface preferences.
                </p>
              </div>

              <section className="mb-6 rounded-2xl border border-border/70 bg-white/[0.03] p-5">
                <div className="mb-4 flex items-center gap-2">
                  <KeyRound className="size-4 text-primary" />
                  <h2 className="text-sm font-semibold text-foreground">Provider</h2>
                </div>
                <div className="grid gap-4">
                  <Field label="Provider name">
                    <Input value={providerName} onChange={(e) => setProviderName(e.target.value)} />
                  </Field>
                  <Field label="Base URL">
                    <Input
                      value={baseURL}
                      onChange={(e) => setBaseURL(e.target.value)}
                      placeholder="https://api.openai.com/v1"
                    />
                  </Field>
                  <Field label="Model">
                    <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o" />
                  </Field>
                  <Field
                    label="API key"
                    hint={
                      initial?.hasApiKey && (
                        <span className="text-xs text-muted-foreground">(a key is saved)</span>
                      )
                    }
                  >
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={initial?.hasApiKey ? "•••••••• (leave blank to keep)" : "sk-..."}
                    />
                  </Field>
                </div>
              </section>

              <section className="mb-6 rounded-2xl border border-border/70 bg-white/[0.03] p-5">
                <div className="mb-4 flex items-center gap-2">
                  <FolderOpen className="size-4 text-primary" />
                  <h2 className="text-sm font-semibold text-foreground">Workspace</h2>
                </div>
                <Field label="Workspace folder">
                  <div className="flex gap-2">
                    <Input value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} />
                    <Button type="button" variant="outline" onClick={pick}>
                      Choose...
                    </Button>
                  </div>
                </Field>
              </section>

              <section className="mb-6 rounded-2xl border border-border/70 bg-white/[0.03] p-5">
                <div className="mb-4 flex items-center gap-2">
                  <SlidersHorizontal className="size-4 text-primary" />
                  <h2 className="text-sm font-semibold text-foreground">Placeholder Settings</h2>
                </div>
                <div className="grid gap-3">
                  <PlaceholderSetting
                    title="Auto approve safe reads"
                    description="Allow low-risk file reads without interrupting the flow. Placeholder only."
                    enabled
                  />
                  <PlaceholderSetting
                    title="Compact transcript"
                    description="Reduce vertical spacing in active chats. Placeholder only."
                  />
                  <PlaceholderSetting
                    title="Terminal shell"
                    description="Choose the default shell for new terminal tabs. Placeholder only."
                    enabled
                  />
                  <PlaceholderSetting
                    title="Theme accent"
                    description="Customize the cozycode accent color. Placeholder only."
                  />
                </div>
              </section>

              {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

              <div className="flex justify-end gap-2">
                {configured && (
                  <Button variant="ghost" onClick={closeSettings}>
                    Cancel
                  </Button>
                )}
                <Button onClick={save} disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                  {!saving && <Check className="ml-2 size-4" />}
                </Button>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
