import { useEffect, useState } from "react";
import { Check, ChevronRight, FolderOpen, KeyRound, Palette, Shield, SlidersHorizontal, TerminalSquare, X } from "lucide-react";
import { useApp, type SettingsSection } from "../store/app-store";
import { ProvidersSection } from "./settings/ProvidersSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { workspaceRoots } from "../../../shared/workspaces.ts";

const sections: Array<{ id: SettingsSection; label: string; icon: typeof SlidersHorizontal }> = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "providers", label: "Providers", icon: KeyRound },
  { id: "workspace", label: "Workspace", icon: FolderOpen },
  { id: "permissions", label: "Permissions", icon: Shield },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "advanced", label: "Advanced", icon: TerminalSquare },
];

export function SettingsPage() {
  const initial = useApp((state) => state.settings);
  const providers = useApp((state) => state.providers);
  const section = useApp((state) => state.settingsSection);
  const configured = Boolean(initial?.workspaceRoot && providers?.connected.length);
  const [workspaceRoot, setWorkspaceRoot] = useState(initial?.workspaceRoot ?? "");
  const [showContextSize, setShowContextSize] = useState(initial?.showContextSize ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setWorkspaceRoot(initial?.workspaceRoot ?? ""), [initial]);
  useEffect(() => setShowContextSize(initial?.showContextSize ?? false), [initial]);

  const save = async () => {
    if (!workspaceRoot) return setError("A workspace folder is required.");
    if (!providers?.connected.length) {
      useApp.getState().openSettings("providers");
      return setError("Connect a provider before continuing.");
    }
    setSaving(true);
    try {
      const saved = await window.cozy.saveSettings({
        workspaceRoot,
        openWorkspaceRoots: workspaceRoots(workspaceRoot, initial?.openWorkspaceRoots),
        permissions: initial?.permissions,
        recentModels: useApp.getState().recentModels,
        showContextSize,
      });
      useApp.getState().setSettings(saved);
      useApp.getState().closeSettings();
      if (!configured) await useApp.getState().bootstrap();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-screen min-h-0 flex-col bg-surface-content backdrop-blur-2xl">
      <header className="app-drag flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3">
        <div className="min-w-0 truncate px-2 pl-28 text-sm font-medium text-foreground/85">Settings</div>
        {configured && (
          <button type="button" onClick={() => useApp.getState().closeSettings()} className="app-no-drag flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-white/8 hover:text-foreground">
            <X className="size-4" />
          </button>
        )}
      </header>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="w-64 shrink-0 border-r border-border/70 bg-sidebar/80 p-3 backdrop-blur-2xl">
          <div className="mb-3 px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Configure</div>
          <nav className="flex flex-col gap-1">
            {sections.map((item) => {
              const Icon = item.icon;
              const active = item.id === section;
              return (
                <button key={item.id} type="button" onClick={() => useApp.setState({ settingsSection: item.id })} className={cn("app-no-drag flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm", active ? "bg-white/10 text-foreground" : "text-muted-foreground hover:bg-white/6 hover:text-foreground")}>
                  <Icon className="size-4" /><span className="flex-1">{item.label}</span>{active && <ChevronRight className="size-3.5" />}
                </button>
              );
            })}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl">
            <div className="mb-6"><h1 className="text-2xl font-semibold tracking-tight">{sections.find((item) => item.id === section)?.label}</h1></div>
            {section === "providers" ? <ProvidersSection /> : section === "workspace" || section === "general" ? (
              <section className="rounded-2xl border border-border/70 bg-white/3 p-5">
                <div className="mb-4 flex items-center gap-2"><FolderOpen className="size-4 text-primary" /><h2 className="text-sm font-semibold">Workspace</h2></div>
                <div className="flex gap-2">
                  <Input value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} placeholder="Workspace folder" />
                  <Button variant="outline" onClick={async () => { const dir = await window.cozy.pickWorkspace(); if (dir) setWorkspaceRoot(dir); }}>Choose…</Button>
                </div>
              </section>
            ) : section === "appearance" ? (
              <section className="rounded-2xl border border-border/70 bg-white/3 p-5">
                <div className="mb-4 flex items-center gap-2"><Palette className="size-4 text-primary" /><h2 className="text-sm font-semibold">Model Picker</h2></div>
                <label className="flex cursor-pointer items-center gap-3">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showContextSize}
                    onClick={() => setShowContextSize((v) => !v)}
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors",
                      showContextSize ? "bg-primary" : "bg-white/10",
                    )}
                  >
                    <span className={cn("pointer-events-none block size-4 rounded-full bg-white shadow transition-transform", showContextSize ? "translate-x-4" : "translate-x-0")} />
                  </button>
                  <span className="text-sm">Show context window sizes</span>
                </label>
              </section>
            ) : (
              <section className="rounded-2xl border border-border/70 bg-white/3 p-5 text-sm text-muted-foreground">These settings are coming soon.</section>
            )}
            {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
            <div className="mt-6 flex justify-end gap-2">
              {configured && <Button variant="ghost" onClick={() => useApp.getState().closeSettings()}>Cancel</Button>}
              <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}{!saving && <Check className="size-4" />}</Button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
