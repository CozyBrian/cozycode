import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { auth, oauth, registry, type OAuthFlow } from "@cozycode/core";
import type { CustomProviderInput, OAuthStart, ProviderInfo, ProviderList } from "@cozycode/protocol";
import { loadProviders, openBrowser } from "../providers.ts";
import { theme } from "../theme.ts";
import { DialogPrompt } from "./DialogPrompt.tsx";
import { DialogSelect, type SelectItem } from "./DialogSelect.tsx";

interface Props {
  providers: ProviderList;
  onChange: (providers: ProviderList, providerID?: string) => void;
  onCancel: () => void;
}

type State =
  | { step: "list"; error?: string }
  | { step: "method"; provider: ProviderInfo; error?: string }
  | { step: "api"; provider: ProviderInfo; error?: string }
  | {
      step: "authorizing";
      provider: ProviderInfo;
      attempt: { controller: AbortController; handedOff: boolean };
    }
  | { step: "oauth"; provider: ProviderInfo; flow: OAuthFlow; start: OAuthStart; error?: string }
  | { step: "custom"; field: keyof CustomDraft; draft: CustomDraft; error?: string };

interface CustomDraft {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: string;
}

const EMPTY_CUSTOM: CustomDraft = { id: "", name: "", baseURL: "", apiKey: "", models: "" };
const CUSTOM_FIELDS: Array<keyof CustomDraft> = ["id", "name", "baseURL", "apiKey", "models"];

export function ProviderDialog({ providers, onChange, onCancel }: Props) {
  const [state, setState] = useState<State>({ step: "list" });
  const [spinner, setSpinner] = useState(0);

  const refresh = async (providerID?: string) => onChange(await loadProviders(), providerID);
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setState((current) => ({ ...current, error: message }));
  };

  useEffect(() => {
    if (state.step !== "authorizing") return;
    return () => {
      if (!state.attempt.handedOff) state.attempt.controller.abort();
    };
  }, [state.step]);

  useEffect(() => {
    if (state.step !== "oauth") return;
    const timer = setInterval(() => setSpinner((value) => value + 1), 100);
    return () => {
      clearInterval(timer);
      state.flow.cancel();
    };
  }, [state.step]);

  useKeyboard((key) => {
    if (state.step === "authorizing" && key.name === "escape") {
      state.attempt.controller.abort();
      setState({ step: "method", provider: state.provider });
      return;
    }
    if (state.step !== "oauth") return;
    if (key.name === "escape") {
      state.flow.cancel();
      setState({ step: "method", provider: state.provider });
    }
    if (key.name === "o") void openBrowser(state.start.url).catch(() => {});
  });

  if (state.step === "list") {
    const options: SelectItem<string>[] = [
      ...[...providers.all].sort((a, b) => {
        const connected = Number(providers.connected.includes(b.id)) - Number(providers.connected.includes(a.id));
        return connected || a.name.localeCompare(b.name);
      }).map((provider) => ({
        value: provider.id,
        title: provider.name,
        description: providers.connected.includes(provider.id) ? "connected" : provider.source,
        category: providers.connected.includes(provider.id) ? "Connected" : "Available",
        current: providers.connected.includes(provider.id),
      })),
      { value: "__custom__", title: "Add custom provider…", description: "OpenAI-compatible", category: "Available" },
    ];
    return (
      <DialogSelect
        title="Providers"
        options={options}
        hint={state.error}
        onSelect={(id) => {
          if (id === "__custom__") setState({ step: "custom", field: "id", draft: EMPTY_CUSTOM });
          else {
            const provider = providers.all.find((item) => item.id === id);
            if (provider) setState({ step: "method", provider });
          }
        }}
        onCancel={onCancel}
      />
    );
  }

  if (state.step === "method") {
    const connected = providers.connected.includes(state.provider.id);
    const options: SelectItem<string>[] = state.provider.authMethods.map((method, index) => ({
      value: `${method.type}:${index}`,
      title: method.label,
      description: method.type === "oauth" ? "OAuth" : "API key",
    }));
    if (connected) options.push({ value: "disconnect", title: "Disconnect", description: state.provider.name });
    return (
      <DialogSelect
        title={`Connect ${state.provider.name}`}
        options={options}
        hint={state.error}
        onSelect={(method) => {
          if (method === "disconnect") {
            void auth.remove(state.provider.id).then(() => refresh()).catch(fail);
          } else if (method.startsWith("api:")) {
            setState({ step: "api", provider: state.provider });
          } else {
            const methodIndex = Number(method.split(":")[1]);
            const attempt = { controller: new AbortController(), handedOff: false };
            setState({ step: "authorizing", provider: state.provider, attempt });
            void oauth.authorize(state.provider.id, methodIndex, attempt.controller.signal).then((flow) => {
              if (attempt.controller.signal.aborted) {
                flow.cancel();
                return;
              }
              attempt.handedOff = true;
              setState({ step: "oauth", provider: state.provider, flow, start: flow.start });
              if (flow.browser) void openBrowser(flow.start.url).catch(() => {});
              void flow.promise.then(async (result) => {
                if (result.status === "complete") await refresh(state.provider.id);
                else if (result.status === "failed") {
                  setState({
                    step: "oauth",
                    provider: state.provider,
                    flow,
                    start: flow.start,
                    error: result.message || "Authorization failed.",
                  });
                } else setState({ step: "method", provider: state.provider });
              });
            }).catch((error) => {
              if (!attempt.controller.signal.aborted) {
                setState({
                  step: "method",
                  provider: state.provider,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            });
          }
        }}
        onCancel={() => setState({ step: "list" })}
      />
    );
  }

  if (state.step === "authorizing") {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    return (
      <box justifyContent="center" marginY={1}>
        <box flexDirection="column" width={60} borderStyle="rounded" borderColor={theme.borderActive} backgroundColor={theme.panel} paddingX={2} paddingY={1}>
          <text fg={theme.text}>Connect {state.provider.name}</text>
          <text fg={theme.text}>{frames[spinner % frames.length]} Starting authorization…</text>
          <text fg={theme.muted}>esc cancel</text>
        </box>
      </box>
    );
  }

  if (state.step === "oauth") {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    return (
      <box justifyContent="center" marginY={1}>
        <box flexDirection="column" width={68} borderStyle="rounded" borderColor={theme.borderActive} backgroundColor={theme.panel} paddingX={2} paddingY={1}>
          <text fg={theme.text}>Connect {state.provider.name}</text>
          {state.start.deviceCode ? (
            <box marginY={1}><text fg={theme.primary}>{state.start.deviceCode}</text></box>
          ) : null}
          {state.start.instructions ? <text fg={theme.muted}>{state.start.instructions}</text> : null}
          <text fg={theme.muted}>{state.start.url}</text>
          <text fg={state.error ? theme.warning : theme.text}>
            {state.error || `${frames[spinner % frames.length]} Waiting for authorization…`}
          </text>
          <text fg={theme.muted}>o open browser again · esc cancel</text>
        </box>
      </box>
    );
  }

  if (state.step === "api") {
    return (
      <DialogPrompt
        title={`Connect ${state.provider.name}`}
        label="API key"
        placeholder="Enter API key"
        hint={state.error}
        onSubmit={(key) => {
          if (!key.trim()) return setState({ ...state, error: "API key is required." });
          void registry.providerConfig(state.provider.id)
            .then(() => auth.setKey(state.provider.id, key.trim()))
            .then(() => refresh(state.provider.id))
            .catch(fail);
        }}
        onCancel={() => setState({ step: "method", provider: state.provider })}
      />
    );
  }

  const fieldIndex = CUSTOM_FIELDS.indexOf(state.field);
  const labels: Record<keyof CustomDraft, string> = {
    id: "Provider id (lowercase letters, numbers, - or _)",
    name: "Display name (optional)",
    baseURL: "Base URL",
    apiKey: "API key (optional for local providers)",
    models: "Model ids, comma-separated",
  };
  return (
    <DialogPrompt
      key={state.field}
      title="Add custom provider"
      label={labels[state.field]}
      placeholder={state.field === "baseURL" ? "http://localhost:11434/v1" : undefined}
      hint={state.error}
      allowEmpty={state.field === "name" || state.field === "apiKey" || state.field === "models"}
      onSubmit={(value) => {
        const draft = { ...state.draft, [state.field]: value.trim() };
        const next = CUSTOM_FIELDS[fieldIndex + 1];
        if (next) return setState({ step: "custom", field: next, draft });
        const input: CustomProviderInput = {
          id: draft.id,
          name: draft.name || undefined,
          baseURL: draft.baseURL,
          apiKey: draft.apiKey || undefined,
          models: draft.models.split(",").map((id) => id.trim()).filter(Boolean),
        };
        void registry.addCustom(input).then(() => refresh(input.id)).catch(fail);
      }}
      onCancel={() => setState({ step: "list" })}
    />
  );
}
