import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useApp } from "../store/app-store";
import { ProvidersSection } from "./settings/ProvidersSection";
import { SETTINGS_SECTIONS } from "./settings/sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { workspaceRoots } from "../../../shared/workspaces.ts";

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-20 items-center justify-between gap-6 border-b border-border/60 py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="app-no-drag shrink-0">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const initial = useApp((state) => state.settings);
  const providers = useApp((state) => state.providers);
  const section = useApp((state) => state.settingsSection);
  const sidebarOpen = useApp((state) => state.sidebarOpen);
  const configured = Boolean(initial?.workspaceRoot && providers?.connected.length);
  const [workspaceRoot, setWorkspaceRoot] = useState(initial?.workspaceRoot ?? "");
  const [showContextSize, setShowContextSize] = useState(initial?.showContextSize ?? false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
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
        ...initial,
        workspaceRoot,
        openWorkspaceRoots: workspaceRoots(workspaceRoot, initial?.openWorkspaceRoots),
        permissions: initial?.permissions,
        recentModels: useApp.getState().recentModels,
        showContextSize,
      });
      useApp.getState().setSettings(saved);
      setSaved(true);
      if (!configured) await useApp.getState().bootstrap();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const activeSection = SETTINGS_SECTIONS.find((item) => item.id === section)!;
  const canSave = section === "general" || section === "workspace" || section === "appearance";
  const workspaceTitle = section === "general" ? "Default workspace" : "Workspace folder";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="app-drag flex h-12 shrink-0 items-center border-b border-border/60 px-6">
        <div
          className={cn(
            "min-w-0 truncate text-sm font-medium text-foreground/85 duration-200",
            !sidebarOpen && "pl-42",
          )}
        >
          Settings
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-220">
          <div className="max-w-4xl">
            <div className="mb-10">
              <h1 className="text-2xl font-semibold tracking-tight">{activeSection.label}</h1>
              <p className="mt-2 text-base text-muted-foreground">{activeSection.description}</p>
            </div>
            {section === "providers" ? <ProvidersSection /> : section === "workspace" || section === "general" ? (
              <section className="border-y border-border/70">
                <SettingRow title={workspaceTitle} description="New chats start in this folder.">
                  <div className="flex w-120 max-w-[45vw] gap-2">
                    <Input
                      value={workspaceRoot}
                      onChange={(event) => {
                        setWorkspaceRoot(event.target.value);
                        setSaved(false);
                      }}
                      placeholder="Workspace folder"
                    />
                    <Button variant="outline" onClick={async () => { const dir = await window.cozy.pickWorkspace(); if (dir) { setWorkspaceRoot(dir); setSaved(false); } }}>Choose</Button>
                  </div>
                </SettingRow>
              </section>
            ) : section === "appearance" ? (
              <section className="border-y border-border/70">
                <SettingRow title="Context window sizes" description="Show each model's available context window in the picker.">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={showContextSize}
                    onClick={() => {
                      setShowContextSize((value) => !value);
                      setSaved(false);
                    }}
                    className={cn(
                      "relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors",
                      showContextSize ? "bg-primary" : "bg-white/10",
                    )}
                  >
                    <span className={cn("pointer-events-none block size-4 rounded-full bg-white shadow transition-transform", showContextSize ? "translate-x-4" : "translate-x-0")} />
                  </button>
                </SettingRow>
              </section>
            ) : (
              <p className="text-sm text-muted-foreground">These settings are coming soon.</p>
            )}
            {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
            {canSave && (
              <div className="mt-6 flex items-center justify-end gap-3">
                {saved && <span className="text-sm text-muted-foreground">Saved</span>}
                <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save changes"}{!saving && <Check className="size-4" />}</Button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
