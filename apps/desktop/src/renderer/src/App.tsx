import { useEffect, useRef, useState } from "react";
import type { ApprovalOutcome, ApprovalRequest } from "@cozycode/protocol";
import type { AppSettings } from "../../shared/ipc.ts";
import { foldEvent, userItem, type TranscriptItem } from "./transcript.ts";
import { Settings } from "./components/Settings.tsx";
import { ApprovalModal } from "./components/ApprovalModal.tsx";
import { ToolCard } from "./components/ToolCard.tsx";

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load persisted settings once.
  useEffect(() => {
    window.cozy.getSettings().then((s) => {
      setSettings(s);
      setLoaded(true);
      if (!isConfigured(s)) setShowSettings(true);
    });
  }, []);

  // Subscribe to the session event + approval streams for the app's lifetime.
  useEffect(() => {
    const offEvent = window.cozy.onEvent((event) => {
      setItems((prev) => foldEvent(prev, event));
      if (event.type === "finish" || event.type === "error") setBusy(false);
    });
    const offApproval = window.cozy.onApprovalRequest((req) => setApproval(req));
    return () => {
      offEvent();
      offApproval();
    };
  }, []);

  // Keep the transcript scrolled to the newest content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  const submit = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setItems((prev) => [...prev, userItem(text)]);
    setInput("");
    setBusy(true);
    const res = await window.cozy.send(text);
    if (!res.ok) {
      setBusy(false);
      setItems((prev) => [
        ...prev,
        { id: `err-${Date.now()}`, kind: "error", text: res.error ?? "Unknown error" },
      ]);
    }
  };

  const respond = (outcome: ApprovalOutcome) => {
    if (approval) window.cozy.respondApproval(approval.requestId, outcome);
    setApproval(null);
  };

  const newChat = async () => {
    await window.cozy.reset();
    setItems([]);
    setBusy(false);
  };

  if (!loaded) return <div className="app loading">Loading…</div>;

  if (showSettings) {
    return (
      <div className="app">
        <Settings
          initial={settings}
          onSaved={(s) => {
            setSettings(s);
            setShowSettings(false);
          }}
          onClose={isConfigured(settings) ? () => setShowSettings(false) : undefined}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">cozycode</div>
        <div className="meta">
          {settings?.model} · {truncatePath(settings?.workspaceRoot)}
        </div>
        <div className="actions">
          <button type="button" onClick={newChat}>
            New chat
          </button>
          <button type="button" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </header>

      <div className="transcript" ref={scrollRef}>
        {items.length === 0 && (
          <div className="empty">Ask cozycode to do something in your workspace.</div>
        )}
        {items.map((item) => (
          <TranscriptRow key={item.id} item={item} />
        ))}
        {busy && <div className="thinking">working…</div>}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={input}
          placeholder="Describe a task…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-actions">
          {busy ? (
            <button type="button" onClick={() => window.cozy.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      </form>

      {approval && <ApprovalModal request={approval} onRespond={respond} />}
    </div>
  );
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return <div className="msg user">{item.text}</div>;
    case "assistant":
      return (
        <div className="msg assistant">
          {item.text}
          {item.streaming && <span className="cursor">▍</span>}
        </div>
      );
    case "tool":
      return <ToolCard item={item} />;
    case "error":
      return <div className="msg error-msg">{item.text}</div>;
  }
}

function isConfigured(s: AppSettings | null): boolean {
  return Boolean(s && s.baseURL && s.model && s.workspaceRoot);
}

function truncatePath(p?: string): string {
  if (!p) return "no workspace";
  const parts = p.split("/");
  return parts.length > 2 ? "…/" + parts.slice(-2).join("/") : p;
}
