import { useEffect, useReducer, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { createSession, registry, type Session, type SessionOptions } from "@cozycode/core";
import {
  findCommand,
  parseCommandInput,
  resolveModelRef,
  runCommandInput,
  type CommandContext,
} from "@cozycode/commands";
import type {
  AgentMode,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  ProviderList,
  SessionConfig,
  TokenUsage,
} from "@cozycode/protocol";
import {
  finalizeTurn,
  foldTurn,
  userItem,
  type RenderItem,
} from "./transcript.ts";
import { ApprovalPrompt } from "./components/ApprovalPrompt.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { Help } from "./components/Help.tsx";
import { Logo } from "./components/Logo.tsx";
import { ModelDialog } from "./components/ModelDialog.tsx";
import { ProviderDialog } from "./components/ProviderDialog.tsx";
import { Prompt } from "./components/Prompt.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusFooter } from "./components/StatusFooter.tsx";
import { Viewport } from "./components/Viewport.tsx";
import { theme } from "./theme.ts";
import { loadProviders } from "./providers.ts";

/** Terminals at least this wide auto-show the sidebar inline. */
const WIDE_COLS = 120;

export interface AppProps {
  initialSession: SessionConfig | null;
  initialModel: ModelRef | null;
  workspaceRoot: string;
  /** Test hook: inject a pre-built model, bypassing the network provider. */
  sessionOptions?: SessionOptions;
  onExit?: () => void;
}

type Overlay = "commands" | "help" | "model" | "provider" | null;

const EMPTY_PROVIDERS: ProviderList = { all: [], connected: [] };

export function App({ initialSession, initialModel, workspaceRoot, sessionOptions, onExit }: AppProps) {
  const dimensions = useTerminalDimensions();
  const [history, setHistory] = useState<RenderItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([]);
  const [usage, setUsage] = useState<TokenUsage | undefined>();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [inputKey, setInputKey] = useState(0);
  const [model, setModel] = useState<ModelRef | null>(initialModel);
  const [providers, setProviders] = useState<ProviderList>(EMPTY_PROVIDERS);
  const [recents, setRecents] = useState<ModelRef[]>(initialModel ? [initialModel] : []);
  const [sidebarOverride, setSidebarOverride] = useState<boolean | null>(null);
  const [mode, setMode] = useState<AgentMode>(initialSession?.mode ?? "build");

  // The active turn's items live in a ref (mutated as events stream in); `bump`
  // forces a re-render so the streaming tail stays live below the log.
  const turnRef = useRef<RenderItem[]>([]);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const sessionRef = useRef<Session | null>(null);
  // Tracks the live model so a fresh session (after /new) keeps the selection.
  const modelRef = useRef<ModelRef | null>(initialModel);
  // Tracks the live mode so a fresh session (after /new) keeps the selection.
  const modeRef = useRef<AgentMode>(initialSession?.mode ?? "build");

  const pumpSession = (session: Session) => {
    const flush = () => {
      if (sessionRef.current !== session) return;
      const turn = turnRef.current;
      if (turn.length > 0) setHistory((h) => [...h, ...finalizeTurn(turn)]);
      turnRef.current = [];
    };

    void (async () => {
      for await (const event of session.events) {
        if (sessionRef.current !== session) return;
        if (event.type === "mode-change") {
          modeRef.current = event.mode;
          setMode(event.mode);
        } else if (event.type === "permission-asked") {
          setPermissionQueue((q) => [...q, event.request]);
        } else if (event.type === "permission-replied") {
          setPermissionQueue((q) => q.filter((r) => r.id !== event.requestId));
        } else if (event.type === "finish") {
          setUsage(event.usage);
          flush();
          setBusy(false);
        } else if (event.type === "error") {
          turnRef.current = foldTurn(turnRef.current, event);
          flush();
          setBusy(false);
        } else {
          turnRef.current = foldTurn(turnRef.current, event);
        }
        bump();
      }
    })();
  };

  const sessionConfig = async (ref: ModelRef): Promise<SessionConfig> => {
    const legacy = initialSession && initialModel?.providerID === ref.providerID;
    const provider = legacy ? initialSession.provider : await registry.providerConfig(ref.providerID);
    return {
      ...(initialSession ?? {}),
      provider,
      model: ref.modelID,
      workspaceRoot,
      permissions: initialSession?.permissions,
      mode: modeRef.current,
    };
  };

  const startSession = async (ref: ModelRef, preserveHistory: boolean) => {
    const previous = sessionRef.current;
    const initialHistory = preserveHistory ? previous?.snapshotHistory() : undefined;
    const config = await sessionConfig(ref);
    previous?.close();
    const options = initialHistory ? { ...sessionOptions, initialHistory } : sessionOptions;
    const session = createSession(config, options);
    sessionRef.current = session;
    pumpSession(session);
    return session;
  };

  useEffect(() => {
    let cancelled = false;
    void loadProviders().then(async (list) => {
      if (cancelled) return;
      const legacyProvider = initialSession && initialModel && !list.all.some((item) => item.id === initialModel.providerID)
        ? {
            id: initialModel.providerID,
            name: initialSession.provider.name,
            source: "custom" as const,
            authMethods: [{ type: "api" as const, label: "Configured API" }],
            models: [...new Set([initialModel.modelID, ...(initialSession.models ?? [])])].map((id) => ({ id, name: id })),
          }
        : null;
      const visible = legacyProvider
        ? { ...list, all: [legacyProvider, ...list.all], connected: [legacyProvider.id, ...list.connected] }
        : list;
      setProviders(visible);
      const selected = initialModel ?? visible.defaultModel ?? null;
      modelRef.current = selected;
      setModel(selected);
      if (!selected) return setOverlay("provider");
      try {
        await startSession(selected, false);
      } catch (error) {
        if (!cancelled) {
          setHistory([{ id: "startup-error", kind: "error", text: error instanceof Error ? error.message : String(error) }]);
          setOverlay("provider");
        }
      }
    }).catch((error) => {
      if (!cancelled) {
        setHistory([{ id: "provider-error", kind: "error", text: error instanceof Error ? error.message : String(error) }]);
        setOverlay("provider");
      }
    });
    return () => {
      cancelled = true;
      sessionRef.current?.close();
    };
    // Session is created once for the app's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const exit = () => {
    onExit?.();
    if (!onExit) process.exit(0);
  };

  const wide = (dimensions.width || 0) >= WIDE_COLS;
  const sidebarVisible = sidebarOverride ?? wide;
  const sidebarOverlay = sidebarVisible && !wide;

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") return exit();
    if (key.ctrl && key.name === "p") {
      setOverlay((current) => (current === "commands" ? null : "commands"));
      return;
    }
    // ctrl+o opens the model picker. (ctrl+m is avoided: in legacy terminals
    // it is indistinguishable from Enter, and the textarea already binds the
    // emacs-style ctrl+a/e/f/b/w/d/k/u keys.)
    if (key.ctrl && key.name === "o") {
      setOverlay((current) => (current === "model" ? null : "model"));
      return;
    }
    if (key.ctrl && key.name === "b") {
      setSidebarOverride((current) => !(current ?? wide));
      return;
    }
    // ProviderDialog owns Escape so nested method/prompt steps can go back.
    if (key.name === "escape" && overlay && overlay !== "provider") {
      setOverlay(null);
      return;
    }
    if (key.name === "escape" && busy) sessionRef.current?.abort();
  });

  const resetChat = () => {
    sessionRef.current?.close();
    sessionRef.current = null;
    setPermissionQueue([]);
    setBusy(false);
    setHistory([]);
    turnRef.current = [];
    setUsage(undefined);
    setInputKey((k) => k + 1);
    bump();
    const selected = modelRef.current;
    if (selected) void startSession(selected, false);
  };

  const selectModel = (next: ModelRef) => {
    const previous = modelRef.current;
    modelRef.current = next;
    if (previous?.providerID === next.providerID && sessionRef.current) {
      sessionRef.current.setModel(next.modelID);
      setRecents((items) => [next, ...items.filter((item) => item.providerID !== next.providerID || item.modelID !== next.modelID)].slice(0, 8));
    } else {
      void startSession(next, Boolean(sessionRef.current)).then(() => {
        setRecents((items) => [next, ...items.filter((item) => item.providerID !== next.providerID || item.modelID !== next.modelID)].slice(0, 8));
      }).catch((error) => {
        modelRef.current = previous;
        setModel(previous);
        setHistory((items) => [...items, {
          id: `model-error:${Date.now()}`,
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
        }]);
      });
    }
    setModel(next);
    setOverlay(null);
  };

  const switchModel = (input: string) => {
    const resolved = resolveModelRef(input, providers);
    if ("error" in resolved) return commandCtx.notify("error", resolved.error);
    selectModel(resolved);
  };

  const switchMode = (next: AgentMode) => {
    if (next === modeRef.current) {
      setOverlay(null);
      return;
    }
    modeRef.current = next;
    setMode(next);
    sessionRef.current?.setMode(next);
    setOverlay(null);
  };

  const toggleMode = () => {
    const next: AgentMode = modeRef.current === "plan" ? "build" : "plan";
    modeRef.current = next;
    setMode(next);
    sessionRef.current?.setMode(next);
  };

  // Capabilities the command registry drives. The registry owns *which* command
  // maps to what; this object only supplies the TUI's effects.
  const commandCtx: CommandContext = {
    setMode: switchMode,
    setModel: switchModel,
    newSession: resetChat,
    openModelPicker: () => setOverlay("model"),
    openProviderPicker: () => setOverlay("provider"),
    showHelp: () => setOverlay("help"),
    exit,
    send: (text) => {
      if (!sessionRef.current) {
        setOverlay("provider");
        return;
      }
      setHistory((h) => [...h, userItem(text)]);
      setBusy(true);
      void sessionRef.current?.send(text);
    },
    notify: (_kind, text) =>
      setHistory((h) => [...h, { id: `command:${Date.now()}`, kind: "error", text }]),
  };

  // Run a command selected from the palette (by canonical name, no args).
  const dispatchCommand = (name: string) => {
    setOverlay(null);
    void findCommand(name)?.run(commandCtx, "");
  };

  const submit = (value: string) => {
    const text = value.trim();
    if (!text || busy) return;
    if (parseCommandInput(text)) {
      void runCommandInput(commandCtx, text);
      setInputKey((k) => k + 1);
      return;
    }
    commandCtx.send(text);
    setInputKey((k) => k + 1);
  };

  const respond = (reply: PermissionReply, message?: string) => {
    const front = permissionQueue[0];
    if (!front) return;
    sessionRef.current?.replyPermission(front.id, reply, message);
    // Optimistic; the replied event will also drop it (idempotent).
    setPermissionQueue((q) => q.slice(1));
  };

  const items = [...history, ...turnRef.current];
  const rows = dimensions.height || 0;
  const approval = permissionQueue[0] ?? null;
  const showHome = items.length === 0 && !busy && !approval && !overlay;
  const currentProvider = providers.all.find((provider) => provider.id === model?.providerID);
  const currentModel = currentProvider?.models.find((candidate) => candidate.id === model?.modelID);
  const modelLabel = model
    ? `${currentModel?.name ?? model.modelID} · ${currentProvider?.name ?? model.providerID}`
    : "No model";

  const providersChanged = (next: ProviderList, providerID?: string) => {
    setProviders(next);
    if (providerID) {
      const provider = next.all.find((item) => item.id === providerID);
      const first = provider?.models[0];
      if (first) return selectModel({ providerID, modelID: first.id });
      return setOverlay("model");
    }
    const selected = modelRef.current;
    if (selected && !next.connected.includes(selected.providerID)) {
      sessionRef.current?.close();
      sessionRef.current = null;
      modelRef.current = null;
      setModel(null);
      setBusy(false);
      setPermissionQueue([]);
      return setOverlay("provider");
    }
    setOverlay(selected ? null : "provider");
  };

  return (
    <box flexDirection="column" height={rows || undefined} backgroundColor={theme.bg}>
      <box flexDirection="row" flexGrow={rows ? 1 : undefined}>
        <box flexGrow={1} flexDirection="column" overflow={rows ? "hidden" : undefined}>
          {showHome ? (
            <box flexGrow={rows ? 1 : undefined} flexDirection="column" alignItems="center" justifyContent={rows ? "center" : undefined}>
              <Logo />
              <box marginTop={2}>
                <text fg={theme.text}>Ask anything…</text>
              </box>
              <text fg={theme.muted}>Tip: ctrl+p commands · ctrl+o model · tab mode · /help keybindings</text>
            </box>
          ) : (
            <Viewport items={items} inputEnabled={!overlay} />
          )}
          {overlay === "commands" ? <CommandPalette onSelect={dispatchCommand} /> : null}
          {overlay === "help" ? <Help /> : null}
          {overlay === "model" ? (
            <ModelDialog
              providers={providers}
              current={model}
              recents={recents}
              onSelect={selectModel}
              onConnect={() => setOverlay("provider")}
              onCancel={() => setOverlay(null)}
            />
          ) : null}
          {overlay === "provider" ? (
            <ProviderDialog
              providers={providers}
              onChange={providersChanged}
              onCancel={() => setOverlay(modelRef.current ? null : "provider")}
            />
          ) : null}
          <box flexShrink={0} flexDirection="column" marginTop={1}>
            {approval ? <ApprovalPrompt request={approval} queueLength={permissionQueue.length} onRespond={respond} /> : overlay ? null : <Prompt busy={busy} inputKey={inputKey} modelLabel={modelLabel} mode={mode} workspaceRoot={workspaceRoot} usage={usage} onSubmit={submit} onToggleMode={toggleMode} />}
            <StatusFooter modelLabel={modelLabel} mode={mode} workspaceRoot={workspaceRoot} busy={busy} approvals={permissionQueue.length} />
          </box>
        </box>
        {sidebarVisible ? (
          <Sidebar modelLabel={modelLabel} mode={mode} workspaceRoot={workspaceRoot} usage={usage} items={items} overlay={sidebarOverlay} />
        ) : null}
      </box>
    </box>
  );
}
