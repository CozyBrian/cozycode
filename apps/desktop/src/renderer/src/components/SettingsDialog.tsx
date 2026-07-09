import { useState } from "react";
import type { AppSettingsInput } from "../../../shared/ipc.ts";
import { useApp } from "../store/app-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

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
      <span className="flex items-center gap-2 font-medium">
        {label}
        {hint}
      </span>
      {children}
    </label>
  );
}

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen);
  const initial = useApp((s) => s.settings);
  const closeSettings = useApp((s) => s.closeSettings);
  const setSettings = useApp((s) => s.setSettings);
  const bootstrap = useApp((s) => s.bootstrap);

  const configured = Boolean(initial?.baseURL && initial?.model && initial?.workspaceRoot);

  const [providerName, setProviderName] = useState(initial?.providerName ?? "openai-compatible");
  const [baseURL, setBaseURL] = useState(initial?.baseURL ?? "https://api.openai.com/v1");
  const [model, setModel] = useState(initial?.model ?? "");
  const [workspaceRoot, setWorkspaceRoot] = useState(initial?.workspaceRoot ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      // First-time setup: bootstrap now that a provider exists.
      if (!wasConfigured) await bootstrap();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && configured) closeSettings();
      }}
    >
      <DialogContent
        showCloseButton={configured}
        onEscapeKeyDown={(e) => !configured && e.preventDefault()}
        onInteractOutside={(e) => !configured && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Connect an OpenAI-compatible provider. Model and workspace are defaults for new chats.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
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
              placeholder={initial?.hasApiKey ? "•••••••• (leave blank to keep)" : "sk-…"}
            />
          </Field>
          <Field label="Workspace folder">
            <div className="flex gap-2">
              <Input value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} />
              <Button type="button" variant="outline" onClick={pick}>
                Choose…
              </Button>
            </div>
          </Field>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          {configured && (
            <Button variant="ghost" onClick={closeSettings}>
              Cancel
            </Button>
          )}
          <Button onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
