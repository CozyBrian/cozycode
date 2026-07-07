import { useEffect, useReducer, useRef, useState } from "react";
import { Box, Static, useApp, useInput } from "ink";
import { createSession, type Session, type SessionOptions } from "@cozycode/core";
import type {
  ApprovalHandler,
  ApprovalOutcome,
  ApprovalRequest,
  SessionConfig,
} from "@cozycode/protocol";
import {
  finalizeTurn,
  foldTurn,
  userItem,
  type RenderItem,
} from "./transcript.ts";
import { Item } from "./components/Item.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { Composer } from "./components/Composer.tsx";
import { ApprovalPrompt } from "./components/ApprovalPrompt.tsx";

export interface AppProps {
  config: SessionConfig;
  model: string;
  workspaceRoot: string;
  /** Test hook: inject a pre-built model, bypassing the network provider. */
  sessionOptions?: SessionOptions;
}

export function App({ config, model, workspaceRoot, sessionOptions }: AppProps) {
  const { exit } = useApp();
  const [history, setHistory] = useState<RenderItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [inputKey, setInputKey] = useState(0);

  // The active turn's items live in a ref (mutated as events stream in); `bump`
  // forces a re-render so the streaming tail stays live below the <Static> log.
  const turnRef = useRef<RenderItem[]>([]);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const sessionRef = useRef<Session | null>(null);
  const approvalResolver = useRef<((o: ApprovalOutcome) => void) | null>(null);

  useEffect(() => {
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

    return () => session.close();
    // Session is created once for the app's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    if (key.escape && busy) sessionRef.current?.abort();
    if (key.ctrl && input === "c") exit();
  });

  const submit = (value: string) => {
    const text = value.trim();
    if (!text || busy) return;
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

  return (
    <Box flexDirection="column">
      <StatusBar model={model} workspaceRoot={workspaceRoot} busy={busy} />

      <Static items={history}>{(item) => <Item key={item.id} item={item} />}</Static>

      {turnRef.current.length > 0 && (
        <Box flexDirection="column">
          {turnRef.current.map((item) => (
            <Item key={item.id} item={item} />
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        {approval ? (
          <ApprovalPrompt request={approval} onRespond={respond} />
        ) : (
          <Composer busy={busy} inputKey={inputKey} onSubmit={submit} />
        )}
      </Box>
    </Box>
  );
}
