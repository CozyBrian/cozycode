import { useEffect, useReducer, useRef, useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { createModel, createSession, defaultSessionTitle, loadAgents, registry, type Session, type SessionOptions } from "@cozycode/core";
import {
  cycleEffort,
  effortsForModel,
  findCommand,
  modelKey,
  parseCommandInput,
  resolveEffort,
  resolveModelRef,
  runCommandInput,
  type CommandContext,
} from "@cozycode/commands";
import type {
  AgentInfo,
  AgentMode,
  ModelRef,
  PermissionReply,
  PermissionRequest,
  ProviderList,
  QuestionRequest,
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
import { QuestionPrompt } from "./components/QuestionPrompt.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { DialogPrompt } from "./components/DialogPrompt.tsx";
import { EffortDialog } from "./components/EffortDialog.tsx";
import { Help } from "./components/Help.tsx";
import { Logo } from "./components/Logo.tsx";
import { ModelDialog } from "./components/ModelDialog.tsx";
import { ProviderDialog } from "./components/ProviderDialog.tsx";
import { Prompt } from "./components/Prompt.tsx";
import { SessionDialog, type TuiSessionEntry } from "./components/SessionDialog.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusFooter } from "./components/StatusFooter.tsx";
import { SubagentView } from "./components/SubagentView.tsx";
import { Viewport } from "./components/Viewport.tsx";
import { theme } from "./theme.ts";
import { loadProviders } from "./providers.ts";
import { loadTuiState, saveTuiState } from "./state.ts";

/** Terminals at least this wide auto-show the sidebar inline. */
const WIDE_COLS = 120;

export interface AppProps {
  initialSession: SessionConfig | null;
  initialModel: ModelRef | null;
  workspaceRoot: string;
  /** Test hook: inject a pre-built model, bypassing the network provider. */
  sessionOptions?: SessionOptions;
  /** Test hook: effort ladder to attach to the synthetic test provider's model. */
  testEfforts?: string[];
  onExit?: () => void;
}

type Overlay = "commands" | "help" | "model" | "provider" | "sessions" | "effort" | "rename" | null;

const EMPTY_PROVIDERS: ProviderList = { all: [], connected: [] };

export function App({ initialSession, initialModel, workspaceRoot, sessionOptions, testEfforts, onExit }: AppProps) {
  const dimensions = useTerminalDimensions();
  const [history, setHistory] = useState<RenderItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([]);
  const [questionQueue, setQuestionQueue] = useState<QuestionRequest[]>([]);
  const [usage, setUsage] = useState<TokenUsage | undefined>();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [inputKey, setInputKey] = useState(0);
  const [model, setModel] = useState<ModelRef | null>(initialModel);
  const [providers, setProviders] = useState<ProviderList>(EMPTY_PROVIDERS);
  const [recents, setRecents] = useState<ModelRef[]>(initialModel ? [initialModel] : []);
  const [sidebarOverride, setSidebarOverride] = useState<boolean | null>(null);
  const [mode, setMode] = useState<AgentMode>(initialSession?.mode ?? "build");
  const [effort, setEffort] = useState<string | undefined>(initialSession?.reasoningEffort);
  const [sessions, setSessions] = useState<TuiSessionEntry[]>([]);
  const [activeSessionID, setActiveSessionID] = useState<string | null>(null);
  // When set, the transcript is replaced by a read-only view of this subagent.
  const [drill, setDrill] = useState<string | null>(null);

  // The active turn's items live in a ref (mutated as events stream in); `bump`
  // forces a re-render so the streaming tail stays live below the log.
  const turnRef = useRef<RenderItem[]>([]);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const sessionRef = useRef<Session | null>(null);
  const sessionsRef = useRef(new Map<string, TuiSessionEntry>());
  const sessionTitlesRef = useRef(new Map<string, string>());
  const renamedSessionIDsRef = useRef(new Set<string>());
  const activeSessionIDRef = useRef<string | null>(null);
  const historyRef = useRef<RenderItem[]>([]);
  const usageRef = useRef<TokenUsage | undefined>(undefined);
  // Tracks the live model so a fresh session (after /new) keeps the selection.
  const modelRef = useRef<ModelRef | null>(initialModel);
  const registryProvidersRef = useRef(new Set<string>());
  // Tracks the live mode so a fresh session (after /new) keeps the selection.
  const modeRef = useRef<AgentMode>(initialSession?.mode ?? "build");
  // Tracks the live reasoning effort so a fresh/rebuilt session keeps it.
  const effortRef = useRef<string | undefined>(initialSession?.reasoningEffort);
  // Per-model effort selections persisted across runs (keyed provider/model).
  const tuiStateRef = useRef(loadTuiState());
  // Agent registry (built-ins + config-file agents), loaded once per workspace.
  const agentsRef = useRef<AgentInfo[]>([]);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    usageRef.current = usage;
  }, [usage]);

  const pumpSession = (session: Session) => {
    const flush = () => {
      if (sessionRef.current !== session) return;
      const turn = turnRef.current;
      if (turn.length > 0) {
        setHistory((h) => {
          const next = [...h, ...finalizeTurn(turn)];
          historyRef.current = next;
          return next;
        });
      }
      turnRef.current = [];
    };

    void (async () => {
      for await (const event of session.events) {
        if (sessionRef.current !== session) return;
        if (event.type === "mode-change") {
          modeRef.current = event.mode;
          setMode(event.mode);
        } else if (event.type === "effort-change") {
          effortRef.current = event.effort;
          setEffort(event.effort);
        } else if (event.type === "title-change") {
          if (renamedSessionIDsRef.current.has(session.id)) continue;
          sessionTitlesRef.current.set(session.id, event.title);
          const entry = sessionsRef.current.get(session.id);
          if (entry) {
            sessionsRef.current.set(session.id, { ...entry, title: event.title });
            publishSessions();
          }
        } else if (event.type === "permission-asked") {
          setPermissionQueue((q) => [...q, event.request]);
        } else if (event.type === "permission-replied") {
          setPermissionQueue((q) => q.filter((r) => r.id !== event.requestId));
        } else if (event.type === "question-asked") {
          setQuestionQueue((q) => [...q, event.request]);
        } else if (event.type === "question-answered" || event.type === "question-rejected") {
          setQuestionQueue((q) => q.filter((r) => r.id !== event.requestId));
        } else if (event.type === "finish") {
          usageRef.current = event.usage;
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
    const legacy = initialSession
      && initialModel?.providerID === ref.providerID
      && !registryProvidersRef.current.has(ref.providerID);
    const provider = legacy ? initialSession.provider : await registry.providerConfig(ref.providerID);
    return {
      ...(initialSession ?? {}),
      provider,
      model: ref.modelID,
      workspaceRoot,
      permissions: initialSession?.permissions,
      mode: modeRef.current,
      reasoningEffort: effortRef.current,
    };
  };

  const startSession = async (
    ref: ModelRef,
    preserveHistory: boolean,
    id?: string,
    initialHistory?: SessionOptions["initialHistory"],
    titleProviderList = providers,
  ) => {
    const previous = sessionRef.current;
    const carriedHistory = initialHistory ?? (preserveHistory ? previous?.snapshotHistory() : undefined);
    const config = await sessionConfig(ref);
    previous?.close();
    const options = {
      agents: agentsRef.current,
      ...sessionOptions, // test hook may override (agents, spawnModel, model)
      ...(carriedHistory ? { initialHistory: carriedHistory } : {}),
      ...(id ? { id } : {}),
      ...(!sessionOptions ? { titleModels: await titleModelsFor(titleProviderList) } : {}),
    };
    const session = createSession(config, options);
    sessionRef.current = session;
    pumpSession(session);
    return session;
  };

  const titleModelsFor = async (list: ProviderList) => {
    const candidates = list.all.flatMap((provider) => list.connected.includes(provider.id)
      ? provider.models
        .filter((model) => model.id.toLowerCase() === "deepseek-v4-flash")
        .map((model) => ({ providerID: provider.id, modelID: model.id }))
      : []);
    const models = await Promise.all(candidates.map(async ({ providerID, modelID }) => {
      try {
        return createModel(await registry.providerConfig(providerID), modelID);
      } catch {
        return undefined;
      }
    }));
    return models.filter((model): model is NonNullable<typeof model> => model !== undefined);
  };

  const publishSessions = () => setSessions([...sessionsRef.current.values()]);

  const saveActiveSession = () => {
    const session = sessionRef.current;
    const selected = modelRef.current;
    if (!session || !selected) return;
    const id = activeSessionIDRef.current ?? session.id;
    const title = sessionTitlesRef.current.get(id)
      ?? sessionsRef.current.get(id)?.title
      ?? defaultSessionTitle();
    sessionsRef.current.set(id, {
      id,
      title,
      history: historyRef.current,
      model: selected,
      mode: modeRef.current,
      effort: effortRef.current,
      usage: usageRef.current,
      coreHistory: session.snapshotHistory(),
    });
    activeSessionIDRef.current = id;
    setActiveSessionID(id);
    publishSessions();
  };

  // The effort ladder for the current model ([] hides the control entirely).
  const efforts = effortsForModel(providers, model);

  /**
   * Restore the persisted (stale-dropped) effort for `ref`, updating the ref +
   * state so a subsequent `startSession` seeds it via `sessionConfig`. Uses the
   * passed provider list because `providers` state can lag inside async flows.
   */
  const restoreEffortFor = (ref: ModelRef | null, list: ProviderList): string | undefined => {
    const stored = ref ? tuiStateRef.current.reasoningEffort[modelKey(ref)] : undefined;
    const valid = resolveEffort(stored, effortsForModel(list, ref));
    effortRef.current = valid;
    setEffort(valid);
    return valid;
  };

  /** Apply an effort selection: validate, push to the live session, persist. */
  const applyEffort = (next: string | undefined) => {
    const valid = resolveEffort(next, efforts);
    effortRef.current = valid;
    setEffort(valid);
    sessionRef.current?.setReasoningEffort(valid);
    if (model) {
      const key = modelKey(model);
      if (valid) tuiStateRef.current.reasoningEffort[key] = valid;
      else delete tuiStateRef.current.reasoningEffort[key];
      saveTuiState(tuiStateRef.current);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (sessionOptions && initialSession && initialModel) {
      const provider = {
        id: initialModel.providerID,
        name: initialSession.provider.name,
        source: "custom" as const,
        authMethods: [{ type: "api" as const, label: "Configured API" }],
        models: [...new Set([initialModel.modelID, ...(initialSession.models ?? [])])]
          .map((id) => ({ id, name: id, reasoningEfforts: testEfforts })),
      };
      const list: ProviderList = { all: [provider], connected: [provider.id], defaultModel: initialModel };
      setProviders(list);
      restoreEffortFor(initialModel, list);
      void startSession(initialModel, false);
      return () => {
        cancelled = true;
        sessionRef.current?.close();
      };
    }
    void loadProviders().then(async (list) => {
      if (cancelled) return;
      agentsRef.current = await loadAgents({ workspaceRoot }).catch(() => agentsRef.current);
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
      restoreEffortFor(selected, visible);
      try {
        await startSession(selected, false, undefined, undefined, visible);
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
    // Ctrl+L is reported as "clear" by some terminal emulators.
    if (key.ctrl && (key.name === "l" || key.name === "clear")) {
      if (busy) return;
      saveActiveSession();
      setOverlay("sessions");
      return;
    }
    if (key.ctrl && key.name === "n") {
      if (!busy) void newSession();
      return;
    }
    if (key.ctrl && key.name === "b") {
      setSidebarOverride((current) => !(current ?? wide));
      return;
    }
    // ctrl+t cycles reasoning effort: default → weakest → … → strongest → default.
    if (key.ctrl && key.name === "t") {
      if (efforts.length > 0) applyEffort(cycleEffort(effortRef.current, efforts));
      return;
    }
    // ProviderDialog owns Escape so nested method/prompt steps can go back.
    if (key.name === "escape" && overlay && overlay !== "provider") {
      setOverlay(null);
      return;
    }
    // The QuestionPrompt owns esc while a question is pending; SubagentView owns
    // esc while drilled in. Only abort when neither is active.
    if (key.name === "escape" && busy && permissionQueue.length === 0 && questionQueue.length === 0 && !drill) {
      sessionRef.current?.abort();
      // End the local turn immediately; a provider can take time to deliver the
      // stream cancellation, but the UI should not keep presenting it as live.
      const turn = turnRef.current;
      if (turn.length > 0) {
        setHistory((history) => [...history, ...finalizeTurn(turn, "Stopped.")]);
        turnRef.current = [];
      }
      setBusy(false);
    }
  });

  const newSession = async () => {
    if (busy) return;
    saveActiveSession();
    sessionRef.current?.close();
    sessionRef.current = null;
    setPermissionQueue([]);
    setQuestionQueue([]);
    setBusy(false);
    setHistory([]);
    turnRef.current = [];
    setUsage(undefined);
    usageRef.current = undefined;
    setInputKey((k) => k + 1);
    bump();
    const selected = modelRef.current;
    if (!selected) return setOverlay("provider");
    try {
      const session = await startSession(selected, false);
      activeSessionIDRef.current = session.id;
      setActiveSessionID(session.id);
      sessionsRef.current.set(session.id, {
        id: session.id,
        title: defaultSessionTitle(),
        history: [],
        model: selected,
        mode: modeRef.current,
        effort: effortRef.current,
        coreHistory: [],
      });
      sessionTitlesRef.current.set(session.id, sessionsRef.current.get(session.id)!.title);
      publishSessions();
      setOverlay(null);
    } catch (error) {
      commandCtx.notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const switchSession = async (id: string) => {
    const entry = sessionsRef.current.get(id);
    if (!entry || id === activeSessionIDRef.current || busy) return setOverlay(null);
    saveActiveSession();
    modelRef.current = entry.model;
    modeRef.current = entry.mode;
    const restoredEffort = resolveEffort(entry.effort, effortsForModel(providers, entry.model));
    effortRef.current = restoredEffort;
    setModel(entry.model);
    setMode(entry.mode);
    setEffort(restoredEffort);
    setHistory(entry.history);
    historyRef.current = entry.history;
    setUsage(entry.usage);
    usageRef.current = entry.usage;
    setPermissionQueue([]);
    setQuestionQueue([]);
    turnRef.current = [];
    try {
      await startSession(entry.model, false, entry.id, entry.coreHistory);
      activeSessionIDRef.current = entry.id;
      setActiveSessionID(entry.id);
      setOverlay(null);
    } catch (error) {
      commandCtx.notify("error", error instanceof Error ? error.message : String(error));
    }
  };

  const selectModel = (next: ModelRef) => {
    const previous = modelRef.current;
    modelRef.current = next;
    // Restore (stale-dropping) the new model's persisted effort before the
    // session rebuilds so it either seeds the config or is pushed live below.
    const restored = restoreEffortFor(next, providers);
    if (previous?.providerID === next.providerID && sessionRef.current) {
      sessionRef.current.setModel(next.modelID);
      sessionRef.current.setReasoningEffort(restored);
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
    newSession: () => void newSession(),
    openSessionPicker: () => {
      if (busy) return;
      saveActiveSession();
      setOverlay("sessions");
    },
    openRenameSession: () => {
      if (!busy && sessionRef.current) setOverlay("rename");
    },
    openModelPicker: () => setOverlay("model"),
    openProviderPicker: () => setOverlay("provider"),
    setEffort: (level) => {
      if (efforts.length === 0) {
        commandCtx.notify("error", "This model has no reasoning-effort control.");
        return;
      }
      const normalized = level.toLowerCase();
      if (normalized === "default" || normalized === "") return applyEffort(undefined);
      if (!efforts.includes(normalized)) {
        commandCtx.notify("error", `Unknown effort "${level}". Available: ${efforts.join(", ")}.`);
        return;
      }
      applyEffort(normalized);
    },
    openEffortPicker: () => {
      if (efforts.length === 0) {
        commandCtx.notify("error", "This model has no reasoning-effort control.");
        return;
      }
      setOverlay("effort");
    },
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

  const answerQuestion = (answers: string[][]) => {
    const front = questionQueue[0];
    if (!front) return;
    sessionRef.current?.answerQuestion(front.id, answers);
    setQuestionQueue((q) => q.slice(1));
  };

  const declineQuestion = () => {
    const front = questionQueue[0];
    if (!front) return;
    sessionRef.current?.rejectQuestion(front.id);
    setQuestionQueue((q) => q.slice(1));
  };

  const items = [...history, ...turnRef.current];
  const rows = dimensions.height || 0;
  const approval = permissionQueue[0] ?? null;
  const question = questionQueue[0] ?? null;
  const drillBlock = drill
    ? items.find(
        (it): it is Extract<RenderItem, { kind: "tool" }> =>
          it.kind === "tool" && it.subagent?.sessionId === drill,
      )?.subagent ?? null
    : null;
  const showHome = items.length === 0 && !busy && !approval && !question && !overlay;
  const currentProvider = providers.all.find((provider) => provider.id === model?.providerID);
  const currentModel = currentProvider?.models.find((candidate) => candidate.id === model?.modelID);
  const modelLabel = model
    ? `${currentModel?.name ?? model.modelID} · ${currentProvider?.name ?? model.providerID}`
    : "No model";

  const providersChanged = (next: ProviderList, providerID?: string) => {
    setProviders(next);
    if (providerID) {
      registryProvidersRef.current.add(providerID);
      const provider = next.all.find((item) => item.id === providerID);
      const first = provider?.models[0];
      if (first) {
        const nextModel = { providerID, modelID: first.id };
        modelRef.current = nextModel;
        setModel(nextModel);
        restoreEffortFor(nextModel, next);
        setRecents((items) => [
          nextModel,
          ...items.filter((item) => item.providerID !== providerID || item.modelID !== first.id),
        ].slice(0, 8));
        void startSession(nextModel, Boolean(sessionRef.current), undefined, undefined, next)
          .then(() => setOverlay(null))
          .catch((error) => commandCtx.notify("error", error instanceof Error ? error.message : String(error)));
        return;
      }
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
    setQuestionQueue([]);
      return setOverlay("provider");
    }
    setOverlay(selected ? null : "provider");
  };

  return (
    <box flexDirection="column" height={rows || undefined} backgroundColor={theme.bg}>
      <box flexDirection="row" flexGrow={rows ? 1 : undefined}>
        <box flexGrow={1} flexDirection="column" overflow={rows ? "hidden" : undefined} paddingX={2} paddingBottom={1}>
          {drillBlock ? (
            <SubagentView block={drillBlock} onClose={() => setDrill(null)} />
          ) : showHome ? (
            <box flexGrow={rows ? 1 : undefined} flexDirection="column" alignItems="center" justifyContent={rows ? "center" : undefined}>
              <Logo />
              <box marginTop={2}>
                <text fg={theme.text}>Ask anything…</text>
              </box>
              <text fg={theme.muted}>Tip: ctrl+p commands · ctrl+o model · tab mode · /help keybindings</text>
            </box>
          ) : (
            <Viewport items={items} inputEnabled={!overlay} onOpenSubagent={setDrill} />
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
          {overlay === "sessions" ? (
            <SessionDialog
              sessions={sessions}
              activeID={activeSessionID}
              onSelect={(id) => void switchSession(id)}
              onCancel={() => setOverlay(null)}
            />
          ) : null}
          {overlay === "effort" ? (
            <EffortDialog
              efforts={efforts}
              current={effort}
              onSelect={(level) => {
                applyEffort(level);
                setOverlay(null);
              }}
              onCancel={() => setOverlay(null)}
            />
          ) : null}
          {overlay === "rename" ? (
            <DialogPrompt
              title="Rename session"
              label="Enter a new title"
              onSubmit={(value) => {
                const id = activeSessionIDRef.current ?? sessionRef.current?.id;
                const title = value.trim();
                if (id && title) {
                  renamedSessionIDsRef.current.add(id);
                  sessionTitlesRef.current.set(id, title);
                  const entry = sessionsRef.current.get(id);
                  if (entry) sessionsRef.current.set(id, { ...entry, title });
                  publishSessions();
                }
                setOverlay(null);
              }}
              onCancel={() => setOverlay(null)}
            />
          ) : null}
          <box flexShrink={0} flexDirection="column" marginTop={1}>
            {approval ? (
              <ApprovalPrompt request={approval} queueLength={permissionQueue.length} onRespond={respond} />
            ) : question ? (
              <QuestionPrompt request={question} onAnswer={answerQuestion} onReject={declineQuestion} />
            ) : overlay ? null : (
              <Prompt busy={busy} inputKey={inputKey} modelLabel={modelLabel} mode={mode} workspaceRoot={workspaceRoot} usage={usage} onSubmit={submit} onToggleMode={toggleMode} />
            )}
            <StatusFooter modelLabel={modelLabel} mode={mode} effort={effort} workspaceRoot={workspaceRoot} busy={busy} approvals={permissionQueue.length} />
          </box>
        </box>
        {sidebarVisible ? sidebarOverlay ? (
          <box position="absolute" top={0} right={0} bottom={0} left={0} alignItems="flex-end" backgroundColor="#00000055" zIndex={40}>
            <Sidebar modelLabel={modelLabel} mode={mode} effort={effort} workspaceRoot={workspaceRoot} usage={usage} items={items} overlay />
          </box>
        ) : (
          <Sidebar modelLabel={modelLabel} mode={mode} effort={effort} workspaceRoot={workspaceRoot} usage={usage} items={items} />
        ) : null}
      </box>
    </box>
  );
}
