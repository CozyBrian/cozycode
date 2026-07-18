import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { RGBA } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  COMMAND_DEFS,
  cycleEffort,
  effortsForModel,
  findCommand,
  formatTranscriptMarkdown,
  modelKey,
  resolveEffort,
  resolveModelRef,
  runCommandInput,
  sessionMarkdownFilename,
  type CommandContext,
} from "@cozycode/commands";
import type { SessionOptions } from "@cozycode/core";
import type {
  AgentMode,
  ModelRef,
  PermissionReply,
  ProviderList,
  SessionConfig,
} from "@cozycode/protocol";
import type { ModelHistory, SessionArchive, SessionTurn } from "@cozycode/sessions";
import {
  createTuiAppRuntime,
  type PromptHistoryData,
} from "./app-runtime.ts";
import { ApprovalPrompt } from "./components/ApprovalPrompt.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { DialogPrompt } from "./components/DialogPrompt.tsx";
import { DialogSelect } from "./components/DialogSelect.tsx";
import { EffortDialog } from "./components/EffortDialog.tsx";
import { ModelDialog } from "./components/ModelDialog.tsx";
import { ProviderDialog } from "./components/ProviderDialog.tsx";
import { QuestionPrompt } from "./components/QuestionPrompt.tsx";
import { SubagentView } from "./components/SubagentView.tsx";
import { Viewport } from "./components/Viewport.tsx";
import {
  Composer,
  type ComposerDraft,
  type ComposerHandle,
  type ComposerSubmission,
  type ComposerStatus,
} from "./components/composer/index.ts";
import {
  AppShell,
  HomeView,
  RevertBar,
  SHELL_WIDE_BREAKPOINT,
  SessionHeader,
  SessionListDialog,
  SessionSidebar,
  ShellHelp,
  WhichKey,
  type AppShellSidebarMode,
  type ShellSessionItem,
} from "./components/shell/index.ts";
import { createActionRegistry } from "./input/index.ts";
import { openExternalEditor } from "./editor.ts";
import {
  expandPastePlaceholders,
  expandWorkspaceReferences,
  indexWorkspaceReferences,
  type PromptHistoryEntry,
} from "./prompt/index.ts";
import {
  selectOrderedSessions,
  selectRenderItems,
} from "./store/index.ts";
import type { TuiSessionStatus } from "./runtime/session-host.ts";
import { loadTuiState, saveTuiState } from "./state.ts";
import { loadTuiConfig, type TuiConfig } from "./tui-config.ts";
import { shortPath, theme } from "./theme.ts";
import type { RenderItem, SubagentBlock } from "./transcript.ts";

export interface AppProps {
  initialSession: SessionConfig | null;
  initialModel: ModelRef | null;
  workspaceRoot: string;
  /** Test hook: inject a pre-built model, bypassing the network provider. */
  sessionOptions?: SessionOptions;
  /** Test hook: effort ladder to attach to the synthetic test provider's model. */
  testEfforts?: string[];
  /** Test hook: bypass provider discovery, including an explicit empty list. */
  testProviders?: ProviderList;
  /** Test hook: isolate renderer tests from the production archive. */
  archive?: SessionArchive;
  onExit?: () => void | Promise<void>;
}

type Overlay =
  | { type: "commands" }
  | { type: "help" }
  | { type: "model" }
  | { type: "provider" }
  | { type: "sessions" }
  | { type: "effort" }
  | { type: "rename"; sessionID: string }
  | { type: "delete"; sessionID: string }
  | { type: "timeline" }
  | { type: "timeline-action"; turnID: string }
  | { type: "branch"; submission: ComposerSubmission }
  | null;

interface Notice {
  kind: "error" | "info";
  text: string;
}

interface AppActionContext {
  newSession(): void;
  openSessions(): void;
  toggleSidebar(): void;
  openModel(): void;
  openPalette(): void;
  undo(): void;
  redo(): void;
  commit(): void;
  openHelp(): void;
  openTimeline(): void;
  openEditor(): void;
  quit(): void;
  cycleEffort(): void;
  clearOrQuit(): void;
  abort(): void;
  cancelOverlay(): void;
  canAbort: boolean;
  canClearOrQuit: boolean;
  overlayCancelable: boolean;
}

const EMPTY_PROVIDERS: ProviderList = { all: [], connected: [] };
const EMPTY_DRAFT: ComposerDraft = {
  text: "",
  revision: 0,
  cursor: 0,
  promptMode: "normal",
  pastePlaceholders: [],
};

export function App({
  initialSession,
  initialModel,
  workspaceRoot,
  sessionOptions,
  testEfforts,
  testProviders,
  archive,
  onExit,
}: AppProps) {
  const dimensions = useTerminalDimensions();
  const renderer = useRenderer();
  const tuiState = useRef(loadTuiState());
  const loadedTuiConfig = useRef(loadTuiConfig()).current;
  const [notice, setNotice] = useState<Notice | null>(null);
  const created = useRef<ReturnType<typeof createTuiAppRuntime> | null>(null);
  if (!created.current) {
    created.current = createTuiAppRuntime({
      initialSession,
      initialModel,
      workspaceRoot,
      sessionOptions,
      testEfforts,
      testProviders,
      archive,
      onError: (error) => setNotice({ kind: "error", text: errorMessage(error) }),
    });
  }
  const runtime = created.current.runtime;
  const state = useSyncExternalStore(runtime.store.subscribe, runtime.store.getSnapshot, runtime.store.getServerSnapshot);
  const historyEntries = useSyncExternalStore(
    runtime.history.subscribe,
    runtime.history.getSnapshot,
    runtime.history.getSnapshot,
  );
  const [providers, setProviders] = useState<ProviderList>(EMPTY_PROVIDERS);
  const [recents, setRecents] = useState<ModelRef[]>(() => recentModels(initialModel, tuiState.current.recentModels));
  const [fallbackModel, setFallbackModel] = useState<ModelRef | null>(initialModel);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [sidebarMode, setSidebarMode] = useState<AppShellSidebarMode>(tuiState.current.sidebarMode);
  const [fileCandidates, setFileCandidates] = useState<ReturnType<typeof indexWorkspaceReferences>["candidates"]>([]);
  const [drill, setDrill] = useState<{ sessionID: string; childID: string } | null>(null);
  const composer = useRef<ComposerHandle | null>(null);
  const exiting = useRef<Promise<void> | null>(null);
  const pendingMutations = useRef(new Set<string>());

  const activeSessionID = state.activeSessionID;
  const activeMetadata = activeSessionID ? state.metadataByID[activeSessionID] : undefined;
  const activeView = activeSessionID ? state.viewsBySessionID[activeSessionID] : undefined;
  const items = selectRenderItems(state, activeSessionID);
  const sessions = selectOrderedSessions(state);
  const currentModel = activeMetadata?.model ?? fallbackModel;
  const efforts = effortsForModel(providers, currentModel);
  const approval = activeView?.pendingPermissions[0];
  const question = activeView?.pendingQuestions[0];
  const drillBlock = drill && drill.sessionID === activeSessionID
    ? findSubagent(items, drill.childID)
    : undefined;
  const narrowSidebarOpen = sidebarMode === "open" && dimensions.width <= SHELL_WIDE_BREAKPOINT;
  const sidebarKeyboardEnabled = narrowSidebarOpen && !overlay && !approval && !question && !drillBlock;

  function notify(kind: Notice["kind"], text: string): void {
    setNotice({ kind, text });
  }

  function persistPreferences(): void {
    try {
      saveTuiState(tuiState.current);
    } catch (error) {
      notify("error", `Could not save TUI preferences: ${errorMessage(error)}`);
    }
  }

  function activateSession(sessionID: string): void {
    const current = runtime.store.getState().activeSessionID;
    if (current && current !== sessionID) runtime.drafts.flush(current);
    runtime.store.setActiveSession(sessionID);
    setDrill(null);
    setOverlay(null);
    const expectedRevision = runtime.store.getState().viewsBySessionID[sessionID]?.revision;
    void Promise.resolve().then(() => {
      try {
        runtime.hydrate(sessionID, expectedRevision);
      } catch (error) {
        notify("error", errorMessage(error));
      }
    });
  }

  async function newSession(model = currentModel): Promise<void> {
    if (!model) {
      setOverlay({ type: "provider" });
      return;
    }
    const current = runtime.store.getState().activeSessionID;
    if (current) runtime.drafts.flush(current);
    try {
      const effort = resolveEffort(tuiState.current.reasoningEffort[modelKey(model)], effortsForModel(providers, model));
      runtime.createSession(model, activeMetadata?.mode ?? initialSession?.mode ?? "build", effort);
      setFallbackModel(model);
      setOverlay(null);
      setDrill(null);
    } catch (error) {
      notify("error", errorMessage(error));
    }
  }

  async function updateMode(mode: AgentMode): Promise<void> {
    if (!activeSessionID) return;
    try {
      runtime.store.upsertMetadata(await runtime.host.setMode(activeSessionID, mode));
    } catch (error) {
      notify("error", errorMessage(error));
    }
  }

  async function selectModel(model: ModelRef): Promise<void> {
    setFallbackModel(model);
    setRecents((current) => {
      const next = recentModels(model, current);
      tuiState.current.recentModels = next;
      persistPreferences();
      return next;
    });
    setOverlay(null);
    if (!activeSessionID) {
      await newSession(model);
      return;
    }
    try {
      runtime.store.upsertMetadata(await runtime.host.setModel(activeSessionID, model));
      const effort = resolveEffort(
        tuiState.current.reasoningEffort[modelKey(model)],
        effortsForModel(providers, model),
      );
      runtime.store.upsertMetadata(await runtime.host.setEffort(activeSessionID, effort));
    } catch (error) {
      notify("error", errorMessage(error));
    }
  }

  async function applyEffort(value: string | undefined): Promise<void> {
    if (!activeSessionID || !currentModel) return;
    const valid = resolveEffort(value, efforts);
    try {
      runtime.store.upsertMetadata(await runtime.host.setEffort(activeSessionID, valid));
      const key = modelKey(currentModel);
      if (valid) tuiState.current.reasoningEffort[key] = valid;
      else delete tuiState.current.reasoningEffort[key];
      persistPreferences();
      setOverlay(null);
    } catch (error) {
      notify("error", errorMessage(error));
    }
  }

  async function undo(): Promise<void> {
    const sessionID = activeSessionID;
    if (!sessionID || !beginMutation(`undo:${sessionID}`)) return;
    runtime.drafts.flush(sessionID);
    try {
      await runtime.host.undo(sessionID);
      runtime.replaceFromArchive(sessionID, true);
    } catch (error) {
      notify("error", errorMessage(error));
    } finally {
      endMutation(`undo:${sessionID}`);
    }
  }

  async function redo(): Promise<void> {
    const sessionID = activeSessionID;
    if (!sessionID || !beginMutation(`redo:${sessionID}`)) return;
    runtime.drafts.flush(sessionID);
    try {
      await runtime.host.redo(sessionID);
      runtime.replaceFromArchive(sessionID, true);
    } catch (error) {
      notify("error", errorMessage(error));
    } finally {
      endMutation(`redo:${sessionID}`);
    }
  }

  async function commitRevert(): Promise<void> {
    const sessionID = activeSessionID;
    const revision = activeView?.rollbackCursor?.revision;
    if (!sessionID || revision === undefined || !beginMutation(`commit:${sessionID}`)) return;
    try {
      await runtime.host.commitRevert(sessionID, {
        expectedRevision: revision,
      });
      runtime.replaceFromArchive(sessionID, true);
      setOverlay(null);
    } catch (error) {
      notify("error", errorMessage(error));
    } finally {
      endMutation(`commit:${sessionID}`);
    }
  }

  async function exportSession(path?: string): Promise<void> {
    if (!activeSessionID || !activeMetadata) return;
    const destination = path
      ? resolve(activeMetadata.workspace ?? workspaceRoot, path)
      : join(activeMetadata.workspace ?? workspaceRoot, sessionMarkdownFilename(activeMetadata.title));
    try {
      await writeFile(destination, formatTranscriptMarkdown(activeMetadata.title, items), "utf8");
      notify("info", `Exported session to ${destination}`);
    } catch (error) {
      notify("error", errorMessage(error));
    }
  }

  async function forkSession(sessionID: string): Promise<void> {
    if (!beginMutation(`fork:${sessionID}`)) return;
    try {
      const metadata = await runtime.host.forkSession(sessionID);
      runtime.store.upsertMetadata(metadata);
      runtime.replaceFromArchive(metadata.id, true);
      setOverlay(null);
    } catch (error) {
      notify("error", errorMessage(error));
    } finally {
      endMutation(`fork:${sessionID}`);
    }
  }

  async function forkFromTurn(turnID: string): Promise<void> {
    const sessionID = activeSessionID;
    if (!sessionID || !beginMutation(`fork:${sessionID}`)) return;
    const source = runtime.archive.listTurns(sessionID).find((turn) => turn.id === turnID);
    if (!source) {
      endMutation(`fork:${sessionID}`);
      notify("error", "The selected turn is no longer available.");
      return;
    }
    const forkDraft = draftForFork(
      source,
      sessionID,
      runtime.archive.getModelHistory(sessionID),
      runtime.history.getSnapshot(),
    );
    try {
      const metadata = await runtime.host.forkFromTurn(sessionID, turnID);
      runtime.store.upsertMetadata(metadata);
      runtime.replaceFromArchive(metadata.id, true);
      const draft = runtime.drafts.get(metadata.id);
      runtime.drafts.replace(metadata.id, {
        text: forkDraft.text,
        cursor: forkDraft.text.length,
        promptMode: forkDraft.mode,
        pastePlaceholders: [],
      }, draft.revision);
      runtime.drafts.flush(metadata.id);
      setOverlay(null);
    } catch (error) {
      notify("error", errorMessage(error));
    } finally {
      endMutation(`fork:${sessionID}`);
    }
  }

  async function undoThrough(turnID: string): Promise<void> {
    const sessionID = activeSessionID;
    if (!sessionID || !beginMutation(`undo:${sessionID}`)) return;
    try {
      while (true) {
        const turns = runtime.archive.listTurns(sessionID);
        const last = turns.at(-1);
        if (!last) throw new Error("The selected turn is no longer visible.");
        await runtime.host.undo(sessionID);
        if (last.id === turnID) break;
        if (!turns.some((turn) => turn.id === turnID)) {
          throw new Error("The selected turn is no longer visible.");
        }
      }
      runtime.replaceFromArchive(sessionID, true);
      setOverlay(null);
    } catch (error) {
      runtime.replaceFromArchive(sessionID, true);
      notify("error", errorMessage(error));
    } finally {
      endMutation(`undo:${sessionID}`);
    }
  }

  async function editExternally(): Promise<void> {
    const sessionID = activeSessionID;
    if (!sessionID) return;
    const draft = runtime.drafts.get(sessionID);
    setOverlay(null);
    composer.current?.blur();
    try {
      const editorText = expandPastePlaceholders(draft.text, draft.pastePlaceholders ?? []).text;
      const text = await openExternalEditor(editorText, {
        suspend: () => renderer.suspend(),
        resume: () => renderer.resume(),
        cwd: activeMetadata?.workspace ?? workspaceRoot,
      });
      const current = runtime.drafts.get(sessionID);
      runtime.drafts.replace(sessionID, {
        text,
        cursor: text.length,
        promptMode: current.promptMode,
        pastePlaceholders: [],
      }, current.revision);
      runtime.drafts.flush(sessionID);
    } catch (error) {
      notify("error", errorMessage(error));
    } finally {
      composer.current?.restoreFocus();
    }
  }

  async function renameSession(sessionID: string, title: string): Promise<void> {
    const value = title.trim();
    if (!value) return;
    try {
      runtime.store.upsertMetadata(await runtime.host.updateSession(sessionID, { title: value }));
      setOverlay(null);
    } catch (error) {
      notify("error", errorMessage(error));
    }
  }

  async function deleteSession(sessionID: string): Promise<void> {
    if (!beginMutation(`delete:${sessionID}`)) return;
    const wasActive = runtime.store.getState().activeSessionID === sessionID;
    runtime.drafts.flush(sessionID);
    try {
      await runtime.host.deleteSession(sessionID);
      runtime.drafts.remove(sessionID);
      runtime.store.removeSession(sessionID);
      setOverlay(null);
      if (!wasActive) return;
      const next = selectOrderedSessions(runtime.store.getState())[0];
      if (next) activateSession(next.id);
      else await newSession(fallbackModel);
    } catch (error) {
      notify("error", errorMessage(error));
    } finally {
      endMutation(`delete:${sessionID}`);
    }
  }

  function requestExit(): Promise<void> {
    if (exiting.current) return exiting.current;
    exiting.current = (async () => {
      try {
        await runtime.close();
      } catch (error) {
        notify("error", errorMessage(error));
      }
      if (onExit) await onExit();
      else process.exit(0);
    })();
    return exiting.current;
  }

  function clearComposerOrExit(): void {
    if (activeSessionID) {
      const draft = runtime.drafts.get(activeSessionID);
      if (composer.current?.current.text || draft.text) {
        runtime.drafts.clear(activeSessionID, draft.revision);
        runtime.drafts.flush(activeSessionID);
        return;
      }
    }
    void requestExit();
  }

  function toggleSidebar(): void {
    const wide = dimensions.width > SHELL_WIDE_BREAKPOINT;
    setSidebarMode((current) => {
      const visible = current === "open" || (current === "auto" && wide);
      const next = visible ? "closed" : "open";
      tuiState.current.sidebarMode = next;
      persistPreferences();
      return next;
    });
  }

  function clearSubmittedDraft(sessionID: string, captured: ComposerDraft): void {
    runtime.drafts.clear(sessionID, captured.revision);
    runtime.drafts.flush(sessionID);
  }

  function restoreFailedDraft(sessionID: string, captured: ComposerDraft): void {
    try {
      runtime.replaceFromArchive(sessionID, runtime.store.getState().activeSessionID === sessionID);
    } catch {}
    const current = runtime.drafts.get(sessionID);
    runtime.drafts.replace(sessionID, {
      text: captured.text,
      cursor: captured.cursor,
      promptMode: captured.promptMode,
      pastePlaceholders: captured.pastePlaceholders,
    }, current.revision);
    runtime.drafts.flush(sessionID);
  }

  function scheduleTurn(submission: ComposerSubmission): boolean {
    const metadata = runtime.store.getState().metadataByID[submission.sessionID];
    if (!metadata) {
      notify("error", "The target session is no longer available.");
      return false;
    }
    if (submission.kind === "shell" && metadata.mode === "plan") {
      notify("error", "Direct shell commands are disabled in read-only plan mode. Switch to build mode first.");
      return false;
    }
    const captured = runtime.drafts.get(submission.sessionID);
    const turnID = randomUUID();
    const displayText = submission.kind === "shell"
      ? `!${submission.displayText}`
      : submission.displayText;
    let operation: Promise<unknown>;
    try {
      runtime.store.beginOptimisticTurn(submission.sessionID, turnID, displayText);
      if (submission.kind === "shell") {
        operation = runtime.host.shell(submission.sessionID, submission.expandedText, { turnID });
      } else {
        const expanded = expandWorkspaceReferences(
          submission.expandedText,
          metadata.workspace ?? workspaceRoot,
        );
        if (expanded.warnings.length > 0) {
          notify("info", expanded.warnings.map((warning) => warning.message).join("; "));
        }
        operation = runtime.host.send(submission.sessionID, expanded.modelText, {
          turnID,
          displayPrompt: submission.displayText,
        });
      }
    } catch (error) {
      restoreFailedDraft(submission.sessionID, captured);
      notify("error", errorMessage(error));
      return false;
    }

    runtime.history.append({
      text: submission.displayText,
      mode: submission.promptMode,
      data: {
        sessionID: submission.sessionID,
        turnID,
        pastePlaceholders: submission.pastePlaceholders.map((item) => ({ ...item })),
      },
    });
    clearSubmittedDraft(submission.sessionID, captured);
    void operation.catch((error) => {
      restoreFailedDraft(submission.sessionID, captured);
      notify("error", errorMessage(error));
    });
    return true;
  }

  async function submit(submission: ComposerSubmission): Promise<boolean> {
    if (submission.unresolvedPastePlaceholders.length > 0) {
      notify("error", "Restore or remove edited paste placeholders before sending.");
      return false;
    }
    if (submission.kind === "command") {
      const handled = await runCommandInput(commandContext, submission.expandedText);
      if (!handled) return false;
      runtime.history.append({
        text: submission.displayText,
        mode: submission.promptMode,
        data: { pastePlaceholders: submission.pastePlaceholders.map((item) => ({ ...item })) },
      });
      const captured = runtime.drafts.get(submission.sessionID);
      clearSubmittedDraft(submission.sessionID, captured);
      return true;
    }
    const view = runtime.store.getState().viewsBySessionID[submission.sessionID];
    if (view?.rollbackCursor) {
      runtime.drafts.flush(submission.sessionID);
      setOverlay({ type: "branch", submission });
      return false;
    }
    return scheduleTurn(submission);
  }

  async function confirmBranch(submission: ComposerSubmission): Promise<void> {
    if (!beginMutation(`commit:${submission.sessionID}`)) return;
    const view = runtime.store.getState().viewsBySessionID[submission.sessionID];
    if (!view?.rollbackCursor) {
      setOverlay(null);
      scheduleTurn(submission);
      endMutation(`commit:${submission.sessionID}`);
      return;
    }
    try {
      await runtime.host.commitRevert(submission.sessionID, {
        expectedRevision: view.rollbackCursor.revision,
      });
      runtime.replaceFromArchive(submission.sessionID, true);
      setOverlay(null);
      scheduleTurn(submission);
    } catch (error) {
      notify("error", errorMessage(error));
    } finally {
      endMutation(`commit:${submission.sessionID}`);
    }
  }

  function beginMutation(key: string): boolean {
    if (pendingMutations.current.has(key)) return false;
    pendingMutations.current.add(key);
    return true;
  }

  function endMutation(key: string): void {
    pendingMutations.current.delete(key);
  }

  function switchModel(input: string): void {
    const result = resolveModelRef(input, providers);
    if ("error" in result) notify("error", result.error);
    else void selectModel(result);
  }

  const commandContext: CommandContext = {
    setMode: (mode) => void updateMode(mode),
    newSession: () => void newSession(),
    openSessionPicker: () => setOverlay({ type: "sessions" }),
    undo: () => void undo(),
    redo: () => void redo(),
    forkSession: () => {
      if (activeSessionID) void forkSession(activeSessionID);
    },
    deleteSession: () => {
      if (activeSessionID) setOverlay({ type: "delete", sessionID: activeSessionID });
    },
    openTimeline: () => setOverlay({ type: "timeline" }),
    openEditor: () => void editExternally(),
    openRenameSession: () => {
      if (activeSessionID) setOverlay({ type: "rename", sessionID: activeSessionID });
    },
    exportSession: (path) => void exportSession(path),
    openModelPicker: () => setOverlay({ type: "model" }),
    openProviderPicker: () => setOverlay({ type: "provider" }),
    setModel: switchModel,
    setEffort: (level) => {
      if (efforts.length === 0) {
        notify("error", "This model has no reasoning-effort control.");
        return;
      }
      const normalized = level.toLowerCase();
      if (!normalized || normalized === "default") void applyEffort(undefined);
      else if (!efforts.includes(normalized)) {
        notify("error", `Unknown effort "${level}". Available: ${efforts.join(", ")}.`);
      } else void applyEffort(normalized);
    },
    openEffortPicker: () => {
      if (efforts.length === 0) notify("error", "This model has no reasoning-effort control.");
      else setOverlay({ type: "effort" });
    },
    showHelp: () => setOverlay({ type: "help" }),
    exit: () => void requestExit(),
    send: (text) => {
      if (!activeSessionID) return;
      scheduleTurn({
        sessionID: activeSessionID,
        kind: "prompt",
        displayText: text,
        expandedText: text,
        promptMode: "normal",
        pastePlaceholders: [],
        unresolvedPastePlaceholders: [],
      });
    },
    notify,
  };

  const actions = useRef(createActions(loadedTuiConfig.config)).current;
  const actionRevision = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot);
  const actionContext: AppActionContext = {
    newSession: () => void newSession(),
    openSessions: () => setOverlay({ type: "sessions" }),
    toggleSidebar,
    openModel: () => setOverlay({ type: "model" }),
    openPalette: () => setOverlay((current) => current?.type === "commands" ? null : { type: "commands" }),
    undo: () => void undo(),
    redo: () => void redo(),
    commit: () => void commitRevert(),
    openHelp: () => setOverlay({ type: "help" }),
    openTimeline: () => setOverlay({ type: "timeline" }),
    openEditor: () => void editExternally(),
    quit: () => void requestExit(),
    cycleEffort: () => {
      if (efforts.length > 0) void applyEffort(cycleEffort(activeMetadata?.effort, efforts));
    },
    clearOrQuit: clearComposerOrExit,
    abort: () => {
      if (activeSessionID) runtime.host.abort(activeSessionID);
    },
    cancelOverlay: () => setOverlay((current) => current?.type === "timeline-action"
      ? { type: "timeline" }
      : null),
    canAbort: Boolean(
      activeSessionID
      && activeView
      && activeView.status !== "idle"
      && activeView.status !== "error"
      && !approval
      && !question
      && !drillBlock
      && !narrowSidebarOpen
    ),
    canClearOrQuit: !overlay && !approval && !question && !drillBlock && !narrowSidebarOpen,
    overlayCancelable: Boolean(overlay && overlay.type !== "provider"),
  };

  useKeyboard((key) => {
    const scopes = overlay
      ? ["base", "prompt", { name: "dialog", modal: true }]
      : ["base", "prompt"];
    const result = actions.dispatch(key, { context: actionContext, scopes });
    if (!result.preventDefault) return;
    key.preventDefault();
    key.stopPropagation();
  });

  useEffect(() => {
    if (!actions.isPending()) return;
    const timer = setTimeout(() => actions.expire(), actions.leaderTimeoutMs);
    return () => clearTimeout(timer);
  }, [actions, actionRevision]);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      const index = indexWorkspaceReferences(workspaceRoot);
      if (cancelled) return;
      setFileCandidates(index.candidates);
      if (index.warnings.length > 0) {
        notify("info", index.warnings.map((warning) => warning.message).join("; "));
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workspaceRoot]);

  useEffect(() => {
    let cancelled = false;
    if (created.current?.warning) notify("error", created.current.warning.message);
    if (loadedTuiConfig.diagnostics.length > 0) {
      notify("error", loadedTuiConfig.diagnostics.join("; "));
    }
    void runtime.initialize().then(({ providers: loaded, errors }) => {
      if (cancelled) return;
      runtime.setProviders(loaded);
      setProviders(loaded);
      if (errors.length > 0) notify("error", errors.map((error) => error.message).join("; "));
      const latest = runtime.latestWorkspaceSession();
      if (latest) {
        setFallbackModel(latest.model);
        setRecents((current) => {
          const next = recentModels(latest.model, current);
          tuiState.current.recentModels = next;
          persistPreferences();
          return next;
        });
        activateSession(latest.id);
        return;
      }
      const selected = initialModel ?? loaded.defaultModel ?? firstConnectedModel(loaded);
      setFallbackModel(selected);
      if (selected) void newSession(selected);
      else setOverlay({ type: "provider" });
    }).catch((error) => {
      if (cancelled) return;
      notify("error", errorMessage(error));
      setOverlay({ type: "provider" });
    });
    return () => {
      cancelled = true;
      void runtime.close();
    };
    // Runtime services are intentionally created once for the renderer lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let receivedSignal = false;
    const handleSignal = (signal: NodeJS.Signals) => {
      if (receivedSignal) {
        process.exit(signalExitCode(signal));
        return;
      }
      receivedSignal = true;
      void requestExit();
    };
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    for (const signal of signals) process.on(signal, handleSignal);
    return () => {
      for (const signal of signals) process.off(signal, handleSignal);
    };
    // Runtime shutdown is idempotent and is intentionally bound once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function providersChanged(next: ProviderList, providerID?: string): void {
    runtime.setProviders(next);
    setProviders(next);
    if (providerID) {
      const model = next.all.find((provider) => provider.id === providerID)?.models[0];
      if (model) void selectModel({ providerID, modelID: model.id });
      else setOverlay({ type: "model" });
      return;
    }
    if (activeMetadata && !next.connected.includes(activeMetadata.model.providerID)) {
      notify("error", `${activeMetadata.model.providerID} is disconnected. Select a connected model to continue.`);
      setOverlay(firstConnectedModel(next) ? { type: "model" } : { type: "provider" });
      return;
    }
    setOverlay(activeSessionID || firstConnectedModel(next) ? null : { type: "provider" });
  }

  const shellSessions: ShellSessionItem[] = sessions.map((metadata) => {
    const view = state.viewsBySessionID[metadata.id];
    return {
      id: metadata.id,
      title: metadata.title,
      workspace: metadata.workspace,
      modelLabel: modelLabel(providers, metadata.model),
      mode: metadata.mode,
      status: view?.status ?? runtime.host.getStatus(metadata.id),
      unread: view?.unread ?? null,
      updatedAt: metadata.updatedAt,
      turnCount: metadata.turnCount,
    };
  });
  const currentModelInfo = providers.all
    .find((provider) => provider.id === currentModel?.providerID)
    ?.models.find((model) => model.id === currentModel?.modelID);
  const activeDraft = activeSessionID ? runtime.drafts.get(activeSessionID) : EMPTY_DRAFT;
  const composerStatus = statusForComposer(activeView?.status);
  const composerNode = (
    <Composer
      ref={(value) => {
        composer.current = value;
      }}
      sessionID={activeSessionID ?? "home"}
      draft={activeDraft}
      status={composerStatus}
      modelLabel={currentModel ? modelLabel(providers, currentModel) : "No model"}
      mode={activeMetadata?.mode ?? initialSession?.mode ?? "build"}
      effortLabel={activeMetadata?.effort}
      workspaceLabel={shortPath(activeMetadata?.workspace ?? workspaceRoot)}
      commandCandidates={COMMAND_DEFS}
      fileCandidates={fileCandidates}
      historyEntries={historyEntries.map(historyForComposer)}
      focused={!overlay && !approval && !question && !drillBlock}
      disabled={!activeSessionID || !currentModel}
      onDraftChange={(update) => runtime.drafts.update(update)}
      onSubmit={submit}
      onSubmitError={(error) => notify("error", errorMessage(error))}
      onModeChange={(mode) => void updateMode(mode)}
    />
  );
  const showHome = !activeSessionID || (items.length === 0 && activeView?.status === "idle");
  const childCount = items.filter((item) => item.kind === "tool" && item.subagent).length;
  const sidebar = activeMetadata ? (
    <SessionSidebar
      title={activeMetadata.title}
      workspace={activeMetadata.workspace}
      modelLabel={modelLabel(providers, activeMetadata.model)}
      mode={activeMetadata.mode}
      effort={activeMetadata.effort}
      usage={activeView?.usage}
      contextWindow={currentModelInfo?.contextWindow}
      sessions={shellSessions}
      currentSessionID={activeSessionID}
      keyboardEnabled={sidebarKeyboardEnabled}
      onSelectSession={activateSession}
    />
  ) : undefined;
  const overlayNode = renderOverlay();

  function renderOverlay() {
    if (!overlay) return <WhichKey visible={actions.isPending()} leaderLabel={actions.leader} />;
    let content: React.ReactNode;
    if (overlay.type === "sessions") {
      content = (
        <SessionListDialog
          sessions={shellSessions}
          currentSessionID={activeSessionID}
          onSelect={activateSession}
          onCancel={() => setOverlay(null)}
          onRename={(sessionID) => setOverlay({ type: "rename", sessionID })}
          onDelete={(sessionID) => setOverlay({ type: "delete", sessionID })}
          onFork={(sessionID) => void forkSession(sessionID)}
        />
      );
    } else if (overlay.type === "timeline") {
      const turns = activeSessionID ? runtime.listRecentTurns(activeSessionID) : [];
      content = (
        <OverlaySurface>
          <DialogSelect
            title="Message timeline"
            placeholder="Search prompts"
            hint="Choose a user turn to undo or fork from"
            options={[...turns].reverse().map((turn) => ({
              value: turn.id,
              title: turnTitle(turn.prompt),
              description: `turn ${turn.ordinal} · ${turn.status}`,
            }))}
            onSelect={(turnID) => setOverlay({ type: "timeline-action", turnID })}
            onCancel={() => setOverlay(null)}
          />
        </OverlaySurface>
      );
    } else if (overlay.type === "timeline-action") {
      const turn = activeSessionID
        ? runtime.listRecentTurns(activeSessionID).find((item) => item.id === overlay.turnID)
        : undefined;
      content = (
        <OverlaySurface>
          <DialogSelect
            title={turn ? turnTitle(turn.prompt) : "Turn unavailable"}
            hint="Filesystem changes are restored when undoing."
            options={turn ? [
              { value: "undo", title: "Undo from this turn", description: "Hide this turn and everything after it" },
              { value: "fork", title: "Fork from this turn", description: "Create a new session and edit this prompt" },
              { value: "cancel", title: "Back" },
            ] : [{ value: "cancel", title: "Close" }]}
            onSelect={(choice) => {
              if (choice === "undo") void undoThrough(overlay.turnID);
              else if (choice === "fork") void forkFromTurn(overlay.turnID);
              else setOverlay({ type: "timeline" });
            }}
            onCancel={() => setOverlay({ type: "timeline" })}
          />
        </OverlaySurface>
      );
    } else if (overlay.type === "help") {
      content = <ShellHelp leaderLabel={actions.leader} onClose={() => setOverlay(null)} />;
    } else if (overlay.type === "commands") {
      content = (
        <OverlaySurface>
          <CommandPalette onSelect={(name) => {
            setOverlay(null);
            void findCommand(name)?.run(commandContext, "");
          }} />
        </OverlaySurface>
      );
    } else if (overlay.type === "model") {
      content = (
        <OverlaySurface>
          <ModelDialog
            providers={providers}
            current={currentModel}
            recents={recents}
            onSelect={(model) => void selectModel(model)}
            onConnect={() => setOverlay({ type: "provider" })}
            onCancel={() => setOverlay(null)}
          />
        </OverlaySurface>
      );
    } else if (overlay.type === "provider") {
      content = (
        <OverlaySurface>
          <ProviderDialog
            providers={providers}
            onChange={providersChanged}
            onCancel={() => {
              if (activeSessionID || firstConnectedModel(providers)) setOverlay(null);
            }}
          />
        </OverlaySurface>
      );
    } else if (overlay.type === "effort") {
      content = (
        <OverlaySurface>
          <EffortDialog
            efforts={efforts}
            current={activeMetadata?.effort}
            onSelect={(value) => void applyEffort(value)}
            onCancel={() => setOverlay(null)}
          />
        </OverlaySurface>
      );
    } else if (overlay.type === "rename") {
      content = (
        <OverlaySurface>
          <DialogPrompt
            title="Rename session"
            label="Enter a new title"
            initialValue={state.metadataByID[overlay.sessionID]?.title ?? ""}
            onSubmit={(title) => void renameSession(overlay.sessionID, title)}
            onCancel={() => setOverlay(null)}
          />
        </OverlaySurface>
      );
    } else if (overlay.type === "delete") {
      content = (
        <OverlaySurface>
          <DialogSelect
            title="Delete session?"
            hint={state.metadataByID[overlay.sessionID]?.title}
            options={[
              { value: "cancel", title: "Cancel" },
              { value: "delete", title: "Delete permanently" },
            ]}
            onSelect={(choice) => choice === "delete"
              ? void deleteSession(overlay.sessionID)
              : setOverlay(null)}
            onCancel={() => setOverlay(null)}
          />
        </OverlaySurface>
      );
    } else {
      const cursor = state.viewsBySessionID[overlay.submission.sessionID]?.rollbackCursor;
      const hidden = cursor ? cursor.originalTurnCount - cursor.visibleTurnCount : 0;
      content = (
        <OverlaySurface>
          <DialogSelect
            title="Replace hidden conversation?"
            hint={`Sending will permanently remove ${hidden} hidden ${hidden === 1 ? "turn" : "turns"}.`}
            options={[
              { value: "cancel", title: "Cancel and keep the draft" },
              { value: "commit", title: "Commit revert and send a new branch" },
            ]}
            onSelect={(choice) => choice === "commit"
              ? void confirmBranch(overlay.submission)
              : setOverlay(null)}
            onCancel={() => setOverlay(null)}
          />
        </OverlaySurface>
      );
    }
    return (
      <>
        {content}
        <WhichKey visible={actions.isPending()} leaderLabel={actions.leader} />
      </>
    );
  }

  return (
    <AppShell
      sidebar={sidebar}
      sidebarMode={sidebarMode}
      sidebarKeyboardEnabled={sidebarKeyboardEnabled}
      onCloseSidebar={() => {
        tuiState.current.sidebarMode = "closed";
        persistPreferences();
        setSidebarMode("closed");
      }}
      overlay={overlayNode}
    >
      {drillBlock ? (
        <>
          {activeMetadata ? (
            <SessionHeader
              title={activeMetadata.title}
              workspace={activeMetadata.workspace}
              status={activeView?.status ?? "idle"}
              child={{ index: 1, total: childCount || 1, label: drillBlock.agent }}
            />
          ) : null}
          <SubagentView block={drillBlock} onClose={() => setDrill(null)} />
        </>
      ) : showHome ? (
        <HomeView
          composer={composerNode}
          hint="ctrl+x then ? for keyboard help"
          footer={notice ? <NoticeBar notice={notice} /> : undefined}
        />
      ) : activeMetadata && activeView ? (
        <>
          <SessionHeader
            title={activeMetadata.title}
            workspace={activeMetadata.workspace}
            status={activeView.status}
            childCount={childCount}
          />
          <box flexGrow={1} minHeight={0} paddingX={2} paddingTop={1}>
            <Viewport
              items={[...items]}
              inputEnabled={!overlay && !approval && !question}
              earlierItemsOmitted={activeView.earlierEventsOmitted || activeView.earlierTurnsOmitted}
              onOpenSubagent={(childID) => setDrill({ sessionID: activeMetadata.id, childID })}
            />
          </box>
          <RevertBar
            hiddenTurnCount={activeView.rollbackCursor
              ? activeView.rollbackCursor.originalTurnCount - activeView.rollbackCursor.visibleTurnCount
              : 0}
            onRedo={() => void redo()}
            onCommit={() => void commitRevert()}
            keyboardEnabled={false}
          />
          <box flexShrink={0} flexDirection="column" paddingX={2} paddingBottom={1}>
            {approval && !overlay ? (
              <ApprovalPrompt
                request={approval}
                queueLength={activeView.pendingPermissions.length}
                onRespond={(reply, message) => respondPermission(activeMetadata.id, approval.id, reply, message)}
              />
            ) : question && !overlay ? (
              <QuestionPrompt
                request={question}
                onAnswer={(answers) => answerQuestion(activeMetadata.id, question.id, answers)}
                onReject={() => rejectQuestion(activeMetadata.id, question.id)}
              />
            ) : composerNode}
          </box>
          {notice ? <NoticeBar notice={notice} /> : null}
        </>
      ) : null}
    </AppShell>
  );

  function respondPermission(
    sessionID: string,
    requestID: string,
    reply: PermissionReply,
    message?: string,
  ): void {
    if (!runtime.host.replyPermission(sessionID, requestID, reply, message)) {
      notify("error", "The permission request is no longer active.");
    }
  }

  function answerQuestion(sessionID: string, requestID: string, answers: string[][]): void {
    if (!runtime.host.answerQuestion(sessionID, requestID, answers)) {
      notify("error", "The question is no longer active.");
    }
  }

  function rejectQuestion(sessionID: string, requestID: string): void {
    if (!runtime.host.rejectQuestion(sessionID, requestID)) {
      notify("error", "The question is no longer active.");
    }
  }
}

function createActions(config: TuiConfig) {
  const actions = createActionRegistry<AppActionContext>([
    { name: "session.new", title: "New session", bindings: "<leader>n", run: (ctx) => ctx.newSession() },
    { name: "session.list", title: "Sessions", bindings: "<leader>l", run: (ctx) => ctx.openSessions() },
    { name: "sidebar.toggle", title: "Toggle sidebar", bindings: "<leader>b", run: (ctx) => ctx.toggleSidebar() },
    { name: "model.open", title: "Model", bindings: "<leader>m", run: (ctx) => ctx.openModel() },
    { name: "palette.open", title: "Palette", bindings: "ctrl+p, <leader>p", run: (ctx) => ctx.openPalette() },
    { name: "session.undo", title: "Undo", bindings: "<leader>u", run: (ctx) => ctx.undo() },
    { name: "session.redo", title: "Redo", bindings: "<leader>r", run: (ctx) => ctx.redo() },
    { name: "session.commit", title: "Commit revert", bindings: "<leader>c", run: (ctx) => ctx.commit() },
    { name: "session.timeline", title: "Timeline", bindings: "<leader>g", run: (ctx) => ctx.openTimeline() },
    { name: "editor.open", title: "External editor", bindings: "<leader>e", run: (ctx) => ctx.openEditor() },
    { name: "help.open", title: "Help", bindings: "<leader>?", run: (ctx) => ctx.openHelp() },
    { name: "app.quit", title: "Quit", bindings: "<leader>q", run: (ctx) => ctx.quit() },
    { name: "effort.cycle", title: "Cycle effort", bindings: "ctrl+t", run: (ctx) => ctx.cycleEffort() },
    {
      name: "session.abort",
      title: "Stop active session",
      bindings: "escape",
      enabled: (ctx) => ctx.canAbort,
      run: (ctx) => ctx.abort(),
    },
    {
      name: "dialog.cancel",
      title: "Close dialog",
      scope: "dialog",
      bindings: "escape",
      enabled: (ctx) => ctx.overlayCancelable,
      run: (ctx) => ctx.cancelOverlay(),
    },
    {
      name: "app.exit",
      title: "Clear prompt or exit",
      scope: "global",
      bindings: "ctrl+c",
      enabled: (ctx) => ctx.canClearOrQuit,
      run: (ctx) => ctx.clearOrQuit(),
    },
  ], {
    ...(config.leader ? { leader: config.leader } : {}),
    ...(config.leaderTimeoutMs !== undefined ? { leaderTimeoutMs: config.leaderTimeoutMs } : {}),
  });
  for (const [name, bindings] of Object.entries(config.keybinds ?? {})) {
    actions.configure(name, bindings);
  }
  return actions;
}

function OverlaySurface({ children }: { children: React.ReactNode }) {
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      right={0}
      bottom={0}
      zIndex={200}
      alignItems="center"
      justifyContent="center"
      backgroundColor={RGBA.fromInts(0, 0, 0, 82)}
    >
      {children}
    </box>
  );
}

function NoticeBar({ notice }: { notice: Notice }) {
  return (
    <box flexShrink={0} paddingX={2} paddingBottom={1}>
      <text fg={notice.kind === "error" ? theme.error : theme.muted}>{notice.text}</text>
    </box>
  );
}

function firstConnectedModel(providers: ProviderList): ModelRef | null {
  for (const provider of providers.all) {
    if (!providers.connected.includes(provider.id)) continue;
    const model = provider.models[0];
    if (model) return { providerID: provider.id, modelID: model.id };
  }
  return null;
}

function modelLabel(providers: ProviderList, ref: ModelRef): string {
  const provider = providers.all.find((item) => item.id === ref.providerID);
  const model = provider?.models.find((item) => item.id === ref.modelID);
  return `${model?.name ?? ref.modelID} / ${provider?.name ?? ref.providerID}`;
}

function statusForComposer(status: TuiSessionStatus | undefined): ComposerStatus {
  if (status === "queued" || status === "waiting" || status === "settling") return status;
  if (status === "running") return "busy";
  return "idle";
}

function historyForComposer(entry: PromptHistoryEntry<PromptHistoryData>) {
  return {
    text: entry.text,
    mode: entry.mode,
    pastePlaceholders: entry.data?.pastePlaceholders,
  };
}

function draftForFork(
  turn: SessionTurn,
  sessionID: string,
  modelHistory: ModelHistory,
  promptHistory: readonly PromptHistoryEntry<PromptHistoryData>[],
): { text: string; mode: "normal" | "shell" } {
  const mode = turn.prompt.startsWith("!") ? "shell" : "normal";
  const displayText = mode === "shell" ? turn.prompt.slice(1) : turn.prompt;
  const persisted = [...promptHistory].reverse().find((entry) =>
    entry.data?.sessionID === sessionID && entry.data.turnID === turn.id
  ) ?? [...promptHistory].reverse().find((entry) =>
    !entry.data?.turnID && (entry.mode ?? "normal") === mode && entry.text === displayText
  );
  if (persisted) {
    const expanded = expandPastePlaceholders(
      persisted.text,
      persisted.data?.pastePlaceholders ?? [],
    );
    if (expanded.unresolved.length === 0) return { text: expanded.text, mode };
  }

  return {
    text: promptFromModelHistory(modelHistory, turn.ordinal, mode) ?? displayText,
    mode,
  };
}

function promptFromModelHistory(
  history: ModelHistory,
  ordinal: number,
  mode: "normal" | "shell",
): string | undefined {
  const message = history.filter((item) => item.role === "user")[ordinal - 1];
  if (!message) return;
  if (mode === "shell" && typeof message.content === "string") {
    const prefix = "Direct shell command:\n";
    if (message.content.startsWith(prefix)) {
      try {
        const command = JSON.parse(message.content.slice(prefix.length));
        if (typeof command === "string") return command;
      } catch {}
    }
  }
  if (typeof message.content === "string") return message.content.replace(/^!/, "");
  if (!Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (part && typeof part === "object" && !Array.isArray(part) && part.type === "text" && typeof part.text === "string") {
      return part.text;
    }
  }
}

function findSubagent(items: readonly RenderItem[], childID: string): SubagentBlock | undefined {
  for (const item of items) {
    if (item.kind !== "tool" || !item.subagent) continue;
    if (item.subagent.sessionId === childID) return item.subagent;
    const nested = findSubagent(item.subagent.items, childID);
    if (nested) return nested;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signalExitCode(signal: NodeJS.Signals): number {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function recentModels(primary: ModelRef | null, existing: readonly ModelRef[]): ModelRef[] {
  const output: ModelRef[] = [];
  const seen = new Set<string>();
  for (const model of primary ? [primary, ...existing] : existing) {
    const key = `${model.providerID}\0${model.modelID}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(model);
    if (output.length === 8) break;
  }
  return output;
}

function turnTitle(prompt: string): string {
  const line = prompt.replace(/^!/, "! ").split(/\r?\n/, 1)[0]?.trim() || "Untitled turn";
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}
