import { useEffect, useReducer, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { createSession, type Session, type SessionOptions } from "@cozycode/core";
import type {
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
import { Prompt } from "./components/Prompt.tsx";
import { StatusFooter } from "./components/StatusFooter.tsx";
import { Viewport } from "./components/Viewport.tsx";
import { theme } from "./theme.ts";

export interface AppProps {
  config: SessionConfig;
  model: string;
  workspaceRoot: string;
  /** Test hook: inject a pre-built model, bypassing the network provider. */
  sessionOptions?: SessionOptions;
  onExit?: () => void;
}

export function App({ config, model, workspaceRoot, sessionOptions, onExit }: AppProps) {
  const dimensions = useTerminalDimensions();
  const [history, setHistory] = useState<RenderItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [usage, setUsage] = useState<TokenUsage | undefined>();
  const [overlay, setOverlay] = useState<"commands" | "help" | null>(null);
  const [inputKey, setInputKey] = useState(0);

  // The active turn's items live in a ref (mutated as events stream in); `bump`
  // forces a re-render so the streaming tail stays live below the <Static> log.
  const turnRef = useRef<RenderItem[]>([]);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const sessionRef = useRef<Session | null>(null);
  const approvalResolver = useRef<((o: ApprovalOutcome) => void) | null>(null);

  const startSession = () => {
    const handler: ApprovalHandler = (req) =>
      new Promise<ApprovalOutcome>((resolve) => {
        approvalResolver.current = resolve;
        setApproval(req);
      });
    const session = createSession(config, handler, sessionOptions);
    sessionRef.current = session;

    const flush = () => {
      const turn = turnRef.current;
      if (turn.length > 0) setHistory((h) => [...h, ...finalizeTurn(turn)]);
      turnRef.current = [];
    };

    void (async () => {
      for await (const event of session.events) {
        if (event.type === "finish") {
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

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") exit();
    if (key.ctrl && key.name === "p") {
      setOverlay((current) => (current === "commands" ? null : "commands"));
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

  const dispatchCommand = (command: Command) => {
    setOverlay(null);
    switch (command) {
      case "new":
      case "clear":
        resetChat();
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
  const footerHeight = approval ? 6 : 5;
  const overlayHeight = overlay ? 9 : 0;
  const viewportHeight = rows ? Math.max(1, rows - footerHeight - overlayHeight) : undefined;
  const showHome = items.length === 0 && !busy && !approval && !overlay;

  return (
    <box flexDirection="column" height={rows || undefined} backgroundColor={theme.bg}>
      <box flexGrow={rows ? 1 : undefined} flexDirection="column" overflow={rows ? "hidden" : undefined}>
        {showHome ? (
          <box flexGrow={rows ? 1 : undefined} flexDirection="column" alignItems="center" justifyContent={rows ? "center" : undefined}>
            <Logo />
            <box marginTop={2}>
              <text fg={theme.text}>Ask anything…</text>
            </box>
            <text fg={theme.muted}>Tip: ctrl+p commands · /help keybindings</text>
          </box>
        ) : (
          <Viewport items={items} height={viewportHeight} inputEnabled={!overlay} />
        )}
        {overlay === "commands" ? <CommandPalette onSelect={dispatchCommand} /> : null}
        {overlay === "help" ? <Help /> : null}
      </box>
      <box flexShrink={0} flexDirection="column" marginTop={1}>
        {approval ? <ApprovalPrompt request={approval} onRespond={respond} /> : <Prompt busy={busy} inputKey={inputKey} model={model} workspaceRoot={workspaceRoot} usage={usage} onSubmit={submit} />}
        <StatusFooter model={model} workspaceRoot={workspaceRoot} busy={busy} approvals={approval ? 1 : 0} />
      </box>
    </box>
  );
}
