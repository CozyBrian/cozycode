import { useState } from "react";
import type { AppSettings, AppSettingsInput } from "../../../shared/ipc.ts";

interface Props {
  initial: AppSettings | null;
  onSaved: (settings: AppSettings) => void;
  onClose?: () => void;
}

export function Settings({ initial, onSaved, onClose }: Props) {
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
      onSaved(await window.cozy.saveSettings(input));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings">
      <h2>Settings</h2>
      <label>
        Provider name
        <input value={providerName} onChange={(e) => setProviderName(e.target.value)} />
      </label>
      <label>
        Base URL (OpenAI-compatible)
        <input
          value={baseURL}
          onChange={(e) => setBaseURL(e.target.value)}
          placeholder="https://api.openai.com/v1"
        />
      </label>
      <label>
        Model
        <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o" />
      </label>
      <label>
        API key {initial?.hasApiKey && <span className="hint">(a key is saved)</span>}
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={initial?.hasApiKey ? "•••••••• (leave blank to keep)" : "sk-..."}
        />
      </label>
      <label>
        Workspace folder
        <div className="row">
          <input value={workspaceRoot} onChange={(e) => setWorkspaceRoot(e.target.value)} />
          <button type="button" onClick={pick}>
            Choose…
          </button>
        </div>
      </label>

      {error && <p className="error">{error}</p>}
      <div className="row end">
        {onClose && (
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        )}
        <button type="button" className="primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
