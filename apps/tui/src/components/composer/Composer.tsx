import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  decodePasteBytes,
  type KeyEvent,
  type PasteEvent,
  type TextareaRenderable,
} from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { AgentMode } from "@cozycode/protocol";
import {
  createHistoryNavigationState,
  detectPromptTrigger,
  expandPastePlaceholders,
  insertPastedText,
  navigatePromptHistory,
  rankFileReferences,
  rankSlashCommands,
  replacePromptTrigger,
  type FileReferenceCandidate,
  type HistoryNavigationState,
  type PastedTextPlaceholder,
  type PromptHistoryEntry,
  type PromptMode,
  type SlashCommandCandidate,
} from "../../prompt/index.ts";
import { theme } from "../../theme.ts";

const KEY_BINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "kpenter", shift: true, action: "newline" as const },
  { name: "return", ctrl: true, action: "newline" as const },
  { name: "kpenter", ctrl: true, action: "newline" as const },
  { name: "return", meta: true, action: "newline" as const },
  { name: "kpenter", meta: true, action: "newline" as const },
  { name: "j", ctrl: true, action: "newline" as const },
  { name: "linefeed", action: "newline" as const },
];

export type ComposerStatusType = "idle" | "busy" | "queued" | "waiting" | "settling";

export type ComposerStatus =
  | ComposerStatusType
  | {
      type: ComposerStatusType;
      label?: string;
    };

export interface ComposerDraft {
  text: string;
  revision: number;
  cursor?: number;
  promptMode?: PromptMode;
  pastePlaceholders?: readonly PastedTextPlaceholder[];
}

export interface ComposerDraftUpdate {
  sessionID: string;
  expectedRevision: number;
  text: string;
  cursor: number;
  promptMode: PromptMode;
  pastePlaceholders: readonly PastedTextPlaceholder[];
}

export interface ComposerCommandCandidate extends SlashCommandCandidate {}

export interface ComposerFileCandidate extends FileReferenceCandidate {
  description?: string;
}

export interface ComposerHistoryEntry {
  text: string;
  promptMode?: PromptMode;
  /** Accepts the prompt utility's history shape without an adapter. */
  mode?: PromptMode;
  pastePlaceholders?: readonly PastedTextPlaceholder[];
  data?: {
    pastePlaceholders?: readonly PastedTextPlaceholder[];
  };
}

export type ComposerSubmissionKind = "prompt" | "command" | "shell";

export interface ComposerSubmission {
  sessionID: string;
  kind: ComposerSubmissionKind;
  displayText: string;
  expandedText: string;
  promptMode: PromptMode;
  pastePlaceholders: readonly PastedTextPlaceholder[];
  unresolvedPastePlaceholders: readonly string[];
}

export interface ComposerProps {
  sessionID: string;
  draft: ComposerDraft;
  status: ComposerStatus;
  modelLabel: string;
  mode: AgentMode;
  effortLabel?: string;
  workspaceLabel: string;
  commandCandidates: readonly ComposerCommandCandidate[];
  fileCandidates: readonly ComposerFileCandidate[];
  historyEntries: readonly ComposerHistoryEntry[];
  focused?: boolean;
  disabled?: boolean;
  onDraftChange: (update: ComposerDraftUpdate) => void;
  onSubmit: (submission: ComposerSubmission) => void | boolean | Promise<void | boolean>;
  onSubmitError?: (error: unknown) => void;
  onModeChange: (mode: AgentMode) => void;
  onEscape?: () => void;
}

export interface ComposerSnapshot {
  text: string;
  cursor: number;
  promptMode: PromptMode;
  pastePlaceholders: readonly PastedTextPlaceholder[];
}

export interface ComposerHandle {
  readonly focused: boolean;
  readonly current: ComposerSnapshot;
  focus(): void;
  restoreFocus(): void;
  blur(): void;
  submit(): Promise<boolean>;
  restorePastes(): void;
}

interface ComposerView extends ComposerSnapshot {
  pastePlaceholders: PastedTextPlaceholder[];
}

interface ComposerHistoryData {
  pastePlaceholders: PastedTextPlaceholder[];
}

type ComposerTrigger = Exclude<ReturnType<typeof detectPromptTrigger>, { kind: "shell" }>;

type Suggestion =
  | { kind: "command"; command: ComposerCommandCandidate }
  | { kind: "file"; file: ComposerFileCandidate };

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, forwardedRef) {
  const dimensions = useTerminalDimensions();
  const inputRef = useRef<TextareaRenderable | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const initialView = draftView(props.draft);
  const viewRef = useRef<ComposerView>(initialView);
  const [view, setView] = useState<ComposerView>(initialView);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [dismissedTrigger, setDismissedTrigger] = useState<string>();
  const historyState = useRef<HistoryNavigationState<ComposerHistoryData>>(createHistoryNavigationState());
  const submitting = useRef(false);
  const pasteSequence = useRef(0);
  const draftRevision = useRef(props.draft.revision);
  const currentSession = useRef(props.sessionID);
  const lastPublished = useRef("");
  const programmaticText = useRef<string[]>([]);

  const detected = detectPromptTrigger(view.text, view.cursor);
  const trigger = detected && detected.kind !== "shell" && triggerKey(detected) !== dismissedTrigger
    ? detected as ComposerTrigger
    : undefined;
  const activeTrigger = view.promptMode === "shell" && trigger?.kind === "command" ? undefined : trigger;
  const suggestions: Suggestion[] = activeTrigger?.kind === "command"
    ? rankSlashCommands(props.commandCandidates, activeTrigger.query, { limit: 8 }).map(({ item }) => ({
        kind: "command",
        command: item,
      }))
    : activeTrigger?.kind === "file"
      ? rankFileReferences(props.fileCandidates, activeTrigger.query, { limit: 8 }).map(({ item }) => ({
          kind: "file",
          file: item,
        }))
      : [];
  const autocompleteVisible = activeTrigger !== undefined;
  const selectedIndex = suggestions.length === 0 ? 0 : Math.min(selectedSuggestion, suggestions.length - 1);
  const status = normalizeStatus(props.status);
  const maxInputHeight = Math.max(1, Math.floor((dimensions.height || 24) / 3));

  function updateView(next: ComposerView, publish = true) {
    viewRef.current = next;
    setView(next);
    if (!publish) return;

    const signature = viewSignature(next);
    if (lastPublished.current === signature) return;
    lastPublished.current = signature;
    const expectedRevision = draftRevision.current++;
    propsRef.current.onDraftChange({
      sessionID: propsRef.current.sessionID,
      expectedRevision,
      text: next.text,
      cursor: next.cursor,
      promptMode: next.promptMode,
      pastePlaceholders: clonePlaceholders(next.pastePlaceholders),
    });
  }

  function replaceDraft(
    text: string,
    cursor: number,
    promptMode: PromptMode,
    placeholders: readonly PastedTextPlaceholder[],
  ) {
    const next: ComposerView = {
      text,
      cursor: clampOffset(text, cursor),
      promptMode,
      pastePlaceholders: reconcilePlaceholders(text, placeholders),
    };
    viewRef.current = next;
    const input = inputRef.current;
    if (input && !input.isDestroyed) {
      if (input.plainText !== text) {
        programmaticText.current.push(text);
        input.setText(text);
      }
      input.clearSelection();
      input.cursorOffset = next.cursor;
    }
    updateView(next);
    setDismissedTrigger(undefined);
    setSelectedSuggestion(0);
  }

  function closeAutocomplete() {
    if (!activeTrigger) return;
    setDismissedTrigger(triggerKey(activeTrigger));
  }

  function acceptSuggestion(index = selectedIndex, expandDirectory = false) {
    const suggestion = suggestions[index];
    const currentTrigger = activeTrigger;
    if (!suggestion || !currentTrigger) return;

    if (suggestion.kind === "command" && currentTrigger.kind === "command") {
      const value = suggestion.command.name.replace(/^\//, "");
      const replacement = replacePromptTrigger(viewRef.current.text, currentTrigger, value);
      replaceDraft(
        replacement.text,
        replacement.cursor,
        viewRef.current.promptMode,
        viewRef.current.pastePlaceholders,
      );
      return;
    }

    if (suggestion.kind !== "file" || currentTrigger.kind !== "file") return;
    const path = suggestion.file.path.replace(/\\/g, "/");
    const directoryPath = suggestion.file.directory && !path.endsWith("/") ? `${path}/` : path;
    const lineRange = suggestion.file.directory ? "" : extractLineRange(currentTrigger.query);
    const replacement = replacePromptTrigger(
      viewRef.current.text,
      currentTrigger,
      `${directoryPath}${lineRange}`,
      expandDirectory && suggestion.file.directory ? "" : undefined,
    );
    replaceDraft(
      replacement.text,
      replacement.cursor,
      viewRef.current.promptMode,
      viewRef.current.pastePlaceholders,
    );
  }

  function moveSuggestion(direction: -1 | 1) {
    if (suggestions.length === 0) return;
    setSelectedSuggestion((current) => (current + direction + suggestions.length) % suggestions.length);
  }

  function navigateHistory(direction: -1 | 1) {
    const input = inputRef.current;
    if (!input) return false;
    const current = viewRef.current;
    const selection = input.getSelection();
    const result = navigatePromptHistory({
      state: historyState.current,
      entries: propsRef.current.historyEntries.map(historyEntry),
      direction,
      current: {
        text: current.text,
        mode: current.promptMode,
        data: { pastePlaceholders: clonePlaceholders(current.pastePlaceholders) },
      },
      cursor: input.cursorOffset,
      selectionStart: selection?.start,
      selectionEnd: selection?.end,
      atFirstLine: input.scrollY + input.visualCursor.visualRow === 0,
      atLastLine:
        input.scrollY + input.visualCursor.visualRow ===
        Math.max(0, input.editorView.getTotalVirtualLineCount() - 1),
    });
    historyState.current = result.state;
    if (result.action === "none") return false;
    if (result.action === "cursor") {
      input.cursorOffset = result.cursor;
      setView((previous) => {
        const next = { ...previous, cursor: result.cursor };
        viewRef.current = next;
        return next;
      });
      return true;
    }

    const mode = result.entry.mode ?? "normal";
    replaceDraft(
      result.entry.text,
      result.cursor,
      mode,
      result.entry.data?.pastePlaceholders ?? [],
    );
    historyState.current = result.state;
    return true;
  }

  async function submitCurrent(): Promise<boolean> {
    if (submitting.current || propsRef.current.disabled) return false;
    const input = inputRef.current;
    const current = viewRef.current;
    const text = input?.plainText ?? current.text;
    if (!text.trim()) return false;

    const placeholders = reconcilePlaceholders(text, current.pastePlaceholders);
    const expanded = expandPastePlaceholders(text, placeholders);
    const submission: ComposerSubmission = {
      sessionID: propsRef.current.sessionID,
      kind: current.promptMode === "shell" ? "shell" : /^\/\S+/.test(text) ? "command" : "prompt",
      displayText: text,
      expandedText: expanded.text,
      promptMode: current.promptMode,
      pastePlaceholders: clonePlaceholders(placeholders),
      unresolvedPastePlaceholders: expanded.unresolved,
    };

    submitting.current = true;
    try {
      const accepted = await propsRef.current.onSubmit(submission);
      return accepted !== false;
    } catch (error) {
      propsRef.current.onSubmitError?.(error);
      return false;
    } finally {
      submitting.current = false;
    }
  }

  function restorePastes() {
    const current = viewRef.current;
    if (current.pastePlaceholders.length === 0) return;
    const restored = expandPastePlaceholders(current.text, current.pastePlaceholders);
    const unresolved = new Set(restored.unresolved);
    const remaining = current.pastePlaceholders.filter((placeholder) => unresolved.has(placeholder.id));
    replaceDraft(restored.text, restored.text.length, current.promptMode, remaining);
  }

  function handleKeyDown(key: KeyEvent) {
    if (propsRef.current.disabled) {
      key.preventDefault();
      return;
    }

    if (autocompleteVisible) {
      if (plainKey(key, "escape")) {
        key.preventDefault();
        key.stopPropagation();
        closeAutocomplete();
        return;
      }
      if (plainKey(key, "up") || plainKey(key, "down")) {
        key.preventDefault();
        moveSuggestion(key.name === "up" ? -1 : 1);
        return;
      }
      if (plainKey(key, "tab")) {
        key.preventDefault();
        const selected = suggestions[selectedIndex];
        acceptSuggestion(selectedIndex, selected?.kind === "file" && selected.file.directory === true);
        return;
      }
      if (plainKey(key, "return") || plainKey(key, "kpenter")) {
        key.preventDefault();
        acceptSuggestion();
        return;
      }
    }

    if (plainKey(key, "tab")) {
      key.preventDefault();
      propsRef.current.onModeChange(propsRef.current.mode === "plan" ? "build" : "plan");
      return;
    }

    if (plainKey(key, "escape") && viewRef.current.promptMode === "shell") {
      key.preventDefault();
      replaceDraft(
        viewRef.current.text,
        viewRef.current.cursor,
        "normal",
        viewRef.current.pastePlaceholders,
      );
      return;
    }

    if (plainKey(key, "backspace") && viewRef.current.promptMode === "shell" && viewRef.current.text.length === 0) {
      key.preventDefault();
      replaceDraft("", 0, "normal", []);
      return;
    }

    const isBang =
      !key.ctrl && !key.meta && !key.super && !key.hyper &&
      (key.name === "!" || key.sequence === "!");
    if (isBang && viewRef.current.promptMode === "normal" && inputRef.current?.cursorOffset === 0) {
      key.preventDefault();
      replaceDraft(
        viewRef.current.text,
        viewRef.current.cursor,
        "shell",
        viewRef.current.pastePlaceholders,
      );
      return;
    }

    if (plainKey(key, "up") && navigateHistory(-1)) {
      key.preventDefault();
      return;
    }
    if (plainKey(key, "down") && navigateHistory(1)) {
      key.preventDefault();
      return;
    }

    if (plainKey(key, "escape")) propsRef.current.onEscape?.();
  }

  function handleContentChange() {
    const input = inputRef.current;
    if (!input) return;
    const text = input.plainText;
    const programmaticIndex = programmaticText.current.lastIndexOf(text);
    if (programmaticIndex !== -1) {
      programmaticText.current.splice(0, programmaticIndex + 1);
      return;
    }
    const current = viewRef.current;
    const next: ComposerView = {
      text,
      cursor: input.cursorOffset,
      promptMode: current.promptMode,
      pastePlaceholders: reconcilePlaceholders(text, current.pastePlaceholders),
    };
    if (next.cursor === current.cursor && viewSignature(next) === viewSignature(current)) return;
    historyState.current = createHistoryNavigationState();
    setDismissedTrigger(undefined);
    setSelectedSuggestion(0);
    updateView(next);
  }

  function handleCursorChange() {
    const input = inputRef.current;
    if (!input) return;
    const cursor = input.cursorOffset;
    if (cursor === viewRef.current.cursor) return;
    const next = { ...viewRef.current, cursor };
    viewRef.current = next;
    setView(next);
    setSelectedSuggestion(0);
  }

  function handlePaste(event: PasteEvent) {
    if (propsRef.current.disabled) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const input = inputRef.current;
    if (!input) return;
    const current = viewRef.current;
    const selection = input.getSelection();
    const start = selection?.start ?? input.cursorOffset;
    const end = selection?.end ?? input.cursorOffset;
    const inserted = insertPastedText(
      current.text,
      start,
      end,
      decodePasteBytes(event.bytes),
      { id: `${propsRef.current.sessionID}:paste:${pasteSequence.current++}` },
    );
    const placeholders = inserted.placeholder
      ? [...current.pastePlaceholders, inserted.placeholder]
      : current.pastePlaceholders;
    replaceDraft(inserted.text, inserted.cursor, current.promptMode, placeholders);
  }

  useLayoutEffect(() => {
    const next = draftView(props.draft);
    const sessionChanged = currentSession.current !== props.sessionID;
    currentSession.current = props.sessionID;
    const externalChange = props.draft.revision !== draftRevision.current;
    draftRevision.current = props.draft.revision;
    const changed = viewSignature(viewRef.current) !== viewSignature(next) || viewRef.current.cursor !== next.cursor;
    viewRef.current = next;
    if (changed) setView(next);
    lastPublished.current = viewSignature(next);
    if (externalChange || sessionChanged) {
      historyState.current = createHistoryNavigationState();
      setDismissedTrigger(undefined);
      setSelectedSuggestion(0);
    }

    const input = inputRef.current;
    if (!input || input.isDestroyed) return;
    if (input.plainText !== next.text) {
      programmaticText.current.push(next.text);
      input.setText(next.text);
    }
    input.cursorOffset = next.cursor;
  }, [props.sessionID, props.draft.revision]);

  useEffect(() => {
    const input = inputRef.current;
    if (props.focused !== false && input && !input.isDestroyed && !input.focused) input.focus();
  }, [props.focused, props.sessionID]);

  useImperativeHandle(forwardedRef, (): ComposerHandle => ({
    get focused() {
      return inputRef.current?.focused ?? false;
    },
    get current() {
      const current = viewRef.current;
      return {
        text: current.text,
        cursor: current.cursor,
        promptMode: current.promptMode,
        pastePlaceholders: clonePlaceholders(current.pastePlaceholders),
      };
    },
    focus() {
      inputRef.current?.focus();
    },
    restoreFocus() {
      inputRef.current?.focus();
    },
    blur() {
      inputRef.current?.blur();
    },
    submit: submitCurrent,
    restorePastes,
  }), []);

  const borderColor = view.promptMode === "shell"
    ? theme.primary
    : status.type === "idle"
      ? props.mode === "plan" ? theme.accent : theme.success
      : theme.warning;
  const modeColor = view.promptMode === "shell"
    ? theme.primary
    : props.mode === "plan" ? theme.accent : theme.success;

  return (
    <box flexDirection="column" width="100%">
      {autocompleteVisible ? (
        <box
          flexDirection="column"
          marginBottom={1}
          borderStyle="rounded"
          borderColor={theme.borderActive}
          backgroundColor={theme.panel}
          maxHeight={Math.max(1, Math.min(8, maxInputHeight))}
          paddingX={1}
        >
          {suggestions.length === 0 ? (
            <text fg={theme.muted}>No matching suggestions</text>
          ) : suggestions.map((suggestion, index) => {
            const selected = index === selectedIndex;
            const label = suggestion.kind === "command"
              ? `/${suggestion.command.name.replace(/^\//, "")}`
              : `@${fileLabel(suggestion.file)}`;
            const description = suggestion.kind === "command"
              ? suggestion.command.description
              : suggestion.file.description ?? (suggestion.file.directory ? "directory" : "file");
            return (
              <box
                key={`${suggestion.kind}:${label}`}
                id={`composer-suggestion-${index}`}
                flexDirection="row"
                backgroundColor={selected ? theme.primary : undefined}
                onMouseOver={() => setSelectedSuggestion(index)}
                onMouseDown={() => setSelectedSuggestion(index)}
                onMouseUp={() => acceptSuggestion(index)}
              >
                <text fg={selected ? theme.bg : theme.text} flexShrink={0}>
                  {label.padEnd(18)}
                </text>
                {description ? (
                  <text fg={selected ? theme.bg : theme.muted} wrapMode="none">{description}</text>
                ) : null}
              </box>
            );
          })}
        </box>
      ) : null}

      <box
        flexDirection="column"
        width="100%"
        border={["left"]}
        borderStyle="heavy"
        borderColor={borderColor}
        backgroundColor={theme.element}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
      >
        <textarea
          ref={(input: TextareaRenderable | null) => {
            inputRef.current = input;
          }}
          initialValue={props.draft.text}
          focused={props.focused !== false}
          width="100%"
          minHeight={1}
          maxHeight={maxInputHeight}
          placeholder={view.promptMode === "shell"
            ? "Run a shell command..."
            : props.mode === "plan" ? "Plan a task (read-only)..." : "Ask anything..."}
          placeholderColor={theme.muted}
          backgroundColor={theme.element}
          focusedBackgroundColor={theme.element}
          textColor={view.promptMode === "shell" ? theme.primary : theme.text}
          focusedTextColor={view.promptMode === "shell" ? theme.primary : theme.text}
          cursorColor={props.disabled ? theme.element : theme.text}
          keyBindings={KEY_BINDINGS}
          onContentChange={handleContentChange}
          onCursorChange={handleCursorChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onSubmit={() => void submitCurrent()}
          onMouseDown={() => inputRef.current?.focus()}
        />

        <box flexDirection="row" justifyContent="space-between" paddingTop={1}>
          <box flexDirection="row" gap={1}>
            <text fg={modeColor}>{view.promptMode === "shell" ? "SHELL" : props.mode.toUpperCase()}</text>
            <text fg={theme.muted}>·</text>
            <text fg={theme.text}>{props.modelLabel}</text>
            {props.effortLabel ? (
              <>
                <text fg={theme.muted}>·</text>
                <text fg={theme.warning}>{props.effortLabel}</text>
              </>
            ) : null}
          </box>
          <text fg={theme.muted} wrapMode="none">{props.workspaceLabel}</text>
        </box>
      </box>

      <box flexDirection="row" justifyContent="space-between" paddingLeft={1}>
        <text fg={status.type === "idle" ? theme.muted : theme.warning}>
          {status.type === "idle" ? "enter send · shift+enter newline" : status.label}
        </text>
        <text fg={theme.muted}>
          {view.promptMode === "shell" ? "esc exit shell" : "tab plan/build · / commands · @ files"}
        </text>
      </box>
    </box>
  );
});

Composer.displayName = "Composer";

function draftView(draft: ComposerDraft): ComposerView {
  return {
    text: draft.text,
    cursor: clampOffset(draft.text, draft.cursor ?? draft.text.length),
    promptMode: draft.promptMode === "shell" ? "shell" : "normal",
    pastePlaceholders: reconcilePlaceholders(draft.text, draft.pastePlaceholders ?? []),
  };
}

function historyEntry(entry: ComposerHistoryEntry): PromptHistoryEntry<ComposerHistoryData> {
  return {
    text: entry.text,
    mode: entry.promptMode ?? entry.mode ?? "normal",
    data: {
      pastePlaceholders: clonePlaceholders(entry.pastePlaceholders ?? entry.data?.pastePlaceholders ?? []),
    },
  };
}

function reconcilePlaceholders(
  text: string,
  placeholders: readonly PastedTextPlaceholder[],
): PastedTextPlaceholder[] {
  const reconciled: PastedTextPlaceholder[] = [];
  let searchFrom = 0;
  for (const placeholder of [...placeholders].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const start = text.indexOf(placeholder.placeholder, searchFrom);
    if (start === -1) continue;
    const end = start + placeholder.placeholder.length;
    reconciled.push({ ...placeholder, start, end });
    searchFrom = end;
  }
  return reconciled;
}

function clonePlaceholders(placeholders: readonly PastedTextPlaceholder[]): PastedTextPlaceholder[] {
  return placeholders.map((placeholder) => ({ ...placeholder }));
}

function viewSignature(view: ComposerView): string {
  return JSON.stringify([
    view.text,
    view.promptMode,
    view.pastePlaceholders.map(({ id, start, end }) => [id, start, end]),
  ]);
}

function triggerKey(trigger: NonNullable<ReturnType<typeof detectPromptTrigger>>): string {
  return `${trigger.kind}:${trigger.start}:${trigger.end}:${trigger.query}`;
}

function extractLineRange(query: string): string {
  return /(#\d+(?:-\d*)?)$/.exec(query)?.[1] ?? "";
}

function fileLabel(file: ComposerFileCandidate): string {
  const path = file.path.replace(/\\/g, "/");
  return file.directory && !path.endsWith("/") ? `${path}/` : path;
}

function normalizeStatus(status: ComposerStatus): { type: ComposerStatusType; label: string } {
  const value = typeof status === "string" ? { type: status } : status;
  const fallback: Record<ComposerStatusType, string> = {
    idle: "idle",
    busy: "● busy · esc interrupt",
    queued: "○ queued",
    waiting: "◇ waiting",
    settling: "· settling",
  };
  return { type: value.type, label: value.label ?? fallback[value.type] };
}

function plainKey(key: KeyEvent, name: string): boolean {
  return key.name === name && !key.ctrl && !key.shift && !key.meta && !key.super && !key.hyper;
}

function clampOffset(text: string, offset: number): number {
  if (!Number.isFinite(offset)) return text.length;
  return Math.max(0, Math.min(text.length, Math.trunc(offset)));
}
