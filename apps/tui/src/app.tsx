import { useEffect, useReducer, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { createSession, type Session, type SessionOptions } from "@cozycode/core";
import type {
  AgentMode,
  ApprovalHandler,
  ApprovalOutcome,
  ApprovalRequest,
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
import { CommandPalette, type Command } from "./components/CommandPalette.tsx";
import { Help } from "./components/Help.tsx";
import { Logo } from "./components/Logo.tsx";
import { ModelDialog } from "./components/ModelDialog.tsx";
import { Prompt } from "./components/Prompt.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusFooter } from "./components/StatusFooter.tsx";
import { Viewport } from "./components/Viewport.tsx";
import { theme } from "./theme.ts";

/** Terminals at least this wide auto-show the sidebar inline. */
const WIDE_COLS = 120;

export interface AppProps {
  config: SessionConfig;
  model: string;
  workspaceRoot: string;
  /** Test hook: inject a pre-built model, bypassing the network provider. */
  sessionOptions?: SessionOptions;
  onExit?: () => void;
}

type Overlay = "commands" | "help" | "model" | null;

export function App({ config, model: initialModel, workspaceRoot, sessionOptions, onExit }: AppProps) {
  const dimensions = useTerminalDimensions();
  const [history, setHistory] = useState<RenderItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [usage, setUsage] = useState<TokenUsage | undefined>();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [inputKey, setInputKey] = useState(0);
  const [model, setModel] = useState(initialModel);
  const [sidebarOverride, setSidebarOverride] = useState<boolean | null>(null);
  const [mode, setMode] = useState<AgentMode>(config.mode ?? "build");

  // The active turn's items live in a ref (mutated as events stream in); `bump`
  // forces a re-render so the streaming tail stays live below the log.
  const turnRef = useRef<RenderItem[]>([]);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const sessionRef = useRef<Session | null>(null);
  const approvalResolver = useRef<((o: ApprovalOutcome) => void) | null>(null);
  // Tracks the live model so a fresh session (after /new) keeps the selection.
  const modelRef = useRef(initialModel);
  // Tracks the live mode so a fresh session (after /new) keeps the selection.
  const modeRef = useRef<AgentMode>(config.mode ?? "build");

  const startSession = () => {
    const handler: ApprovalHandler = (req) =>
      new Promise<ApprovalOutcome>((resolve) => {
        approvalResolver.current = resolve;
        setApproval(req);
      });
    const session = createSession(config, handler, sessionOptions);
    if (modelRef.current !== config.model) session.setModel(modelRef.current);
    if (modeRef.current !== (config.mode ?? "build")) session.setMode(modeRef.current);
    sessionRef.current = session;

    const flush = () => {
      const turn = turnRef.current;
      if (turn.length > 0) setHistory((h) => [...h, ...finalizeTurn(turn)]);
      turnRef.current = [];
    };

    void (async () => {
      for await (const event of session.events) {
        if (event.type === "mode-change") {
          modeRef.current = event.mode;
          setMode(event.mode);
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

    return session;
  };

  useEffect(() => {
    const session = startSession();
    return () => session.close();
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
    if (key.name === "escape" && overlay) {
      setOverlay(null);
      return;
    }
    if (key.name === "escape" && busy) sessionRef.current?.abort();
  });

  const resetChat = () => {
    sessionRef.current?.close();
    sessionRef.current = null;
    approvalResolver.current = null;
    setApproval(null);
    setBusy(false);
    setHistory([]);
    turnRef.current = [];
    setUsage(undefined);
    setInputKey((k) => k + 1);
    bump();
    startSession();
  };

  const switchModel = (next: string) => {
    modelRef.current = next;
    sessionRef.current?.setModel(next);
    setModel(next);
    setOverlay(null);
  };

  const switchMode = (next: AgentMode) => {
    if (next === modeRef.current) {
      setOverlay(null);
      return;
    }
    sessionRef.current?.setMode(next);
    setOverlay(null);
  };

  const toggleMode = () => {
    const next: AgentMode = modeRef.current === "plan" ? "build" : "plan";
    sessionRef.current?.setMode(next);
  };

  const dispatchCommand = (command: Command) => {
    setOverlay(null);
    switch (command) {
      case "new":
      case "clear":
        resetChat();
        break;
      case "model":
        setOverlay("model");
        break;
      case "plan":
        switchMode("plan");
        break;
      case "build":
        switchMode("build");
        break;
      case "help":
        setOverlay("help");
        break;
      case "quit":
        exit();
        break;
    }
  };

  const submit = (value: string) => {
    const text = value.trim();
    if (!text || busy) return;
    if (text.startsWith("/")) {
      switch (text) {
        case "/new":
        case "/clear":
          resetChat();
          break;
        case "/model":
        case "/models":
          setOverlay("model");
          break;
        case "/plan":
          switchMode("plan");
          break;
        case "/build":
          switchMode("build");
          break;
        case "/help":
          setOverlay("help");
          break;
        case "/quit":
        case "/exit":
          exit();
          break;
        default:
          setHistory((h) => [...h, { id: `unknown-command:${Date.now()}`, kind: "error", text: `Unknown command: ${text}` }]);
      }
      setInputKey((k) => k + 1);
      return;
    }
    setHistory((h) => [...h, userItem(text)]);
    setInputKey((k) => k + 1);
    setBusy(true);
    void sessionRef.current?.send(text);
  };

  const respond = (outcome: ApprovalOutcome) => {
    approvalResolver.current?.(outcome);
    approvalResolver.current = null;
    setApproval(null);
  };

  const items = [...history, ...turnRef.current];
  const rows = dimensions.height || 0;
  const showHome = items.length === 0 && !busy && !approval && !overlay;

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
              provider={config.provider}
              current={model}
              configured={config.models}
              onSelect={switchModel}
              onCancel={() => setOverlay(null)}
            />
          ) : null}
          <box flexShrink={0} flexDirection="column" marginTop={1}>
            {approval ? <ApprovalPrompt request={approval} onRespond={respond} /> : <Prompt busy={busy} inputKey={inputKey} model={model} mode={mode} workspaceRoot={workspaceRoot} usage={usage} onSubmit={submit} onToggleMode={toggleMode} />}
            <StatusFooter model={model} mode={mode} workspaceRoot={workspaceRoot} busy={busy} approvals={approval ? 1 : 0} />
          </box>
        </box>
        {sidebarVisible ? (
          <Sidebar model={model} mode={mode} workspaceRoot={workspaceRoot} usage={usage} items={items} overlay={sidebarOverlay} />
        ) : null}
      </box>
    </box>
  );
}
