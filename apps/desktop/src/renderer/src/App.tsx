import { useEffect, useRef, useState } from "react";
import {
  matchPrefix,
  parseCommandInput,
  runCommandInput,
  type CommandContext,
  type CommandDef,
} from "@cozycode/commands";
import type { AgentMode, ApprovalOutcome, ApprovalRequest } from "@cozycode/protocol";
import type { AppSettings } from "../../shared/ipc.ts";
import { foldEvent, userItem, type TranscriptItem } from "./transcript.ts";
import { Settings } from "./components/Settings.tsx";
import { ApprovalModal } from "./components/ApprovalModal.tsx";
import { Help } from "./components/Help.tsx";
import { ToolCard } from "./components/ToolCard.tsx";
import { Button } from "@/components/ui/button";

// The prefix being typed while completing a slash command: the whole input is
// a single "/token" (no space, single line). Anything else means no completion.
function commandQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? match[1]! : null;
}

export function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<AgentMode>("build");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Slash-command autocomplete state, derived from the controlled input.
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const query = commandQuery(input);
  const suggestions = query === null ? [] : matchPrefix(query);
  const showSuggestions = suggestions.length > 0 && !suggestionsDismissed;

  // Reset selection + un-dismiss whenever the input changes.
  useEffect(() => {
    setSelectedSuggestion(0);
    setSuggestionsDismissed(false);
  }, [input]);

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
      if (event.type === "mode-change") setMode(event.mode);
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

  const sendMessage = async (text: string) => {
    setItems((prev) => [...prev, userItem(text)]);
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

  // Capabilities the command registry drives. The registry owns *which* command
  // maps to what; this only supplies the desktop's effects. `setModel` is
  // omitted (no IPC for it yet) so `/model <id>` falls back to opening Settings.
  const commandCtx: CommandContext = {
    setMode: (next) => {
      void window.cozy.setMode(next);
      setMode(next);
    },
    newSession: () => void newChat(),
    openModelPicker: () => setShowSettings(true),
    showHelp: () => setShowHelp(true),
    exit: () => window.close(),
    send: (text) => void sendMessage(text),
    notify: (kind, text) =>
      setItems((prev) => [
        ...prev,
        { id: `cmd-${Date.now()}`, kind: kind === "error" ? "error" : "system", text },
      ]),
  };

  const submit = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    if (parseCommandInput(text)) {
      await runCommandInput(commandCtx, text);
      return;
    }
    await sendMessage(text);
  };

  const acceptSuggestion = (command: CommandDef) => {
    setInput(`/${command.name} `);
    textareaRef.current?.focus();
  };

  const respond = (outcome: ApprovalOutcome) => {
    if (approval) window.cozy.respondApproval(approval.requestId, outcome);
    setApproval(null);
  };

  const newChat = async () => {
    await window.cozy.reset();
    setItems([]);
    setBusy(false);
    setMode("build");
  };

  const toggleMode = () => {
    const next: AgentMode = mode === "plan" ? "build" : "plan";
    void window.cozy.setMode(next);
    // Optimistically update; a mode-change event will confirm it.
    setMode(next);
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
          <button
            type="button"
            className={`mode-pill ${mode}`}
            onClick={toggleMode}
            title="Toggle Plan / Build mode"
          >
            {mode === "plan" ? "PLAN" : "BUILD"}
          </button>
          <span>{settings?.model} · {truncatePath(settings?.workspaceRoot)}</span>
        </div>
        <div className="actions">
          <Button variant="ghost" size="sm" onClick={newChat}>
            New chat
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowSettings(true)}>
            Settings
          </Button>
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
        {showSuggestions && (
          <ul className="command-suggestions">
            {suggestions.map((command, index) => (
              <li key={command.name}>
                <button
                  type="button"
                  className={index === selectedSuggestion ? "selected" : undefined}
                  onMouseDown={(e) => {
                    // Keep textarea focus; run before blur.
                    e.preventDefault();
                    acceptSuggestion(command);
                  }}
                >
                  <span className="name">/{command.name}</span>
                  <span className="desc">{command.description}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          placeholder={mode === "plan" ? "Research a plan (read-only)…" : "Describe a task…"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (showSuggestions) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedSuggestion((s) => (s + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedSuggestion((s) => (s - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Tab" || e.key === "Enter") {
                e.preventDefault();
                const command = suggestions[selectedSuggestion];
                if (command) acceptSuggestion(command);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSuggestionsDismissed(true);
                return;
              }
            }
            if (e.key === "Tab") {
              e.preventDefault();
              toggleMode();
              return;
            }
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
      <Help open={showHelp} onClose={() => setShowHelp(false)} />
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
    case "system":
      return <div className="msg system">{item.text}</div>;
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
