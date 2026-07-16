import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, LoaderCircle, Mic, Plus, Square } from "lucide-react";
import {
  matchPrefix,
  parseCommandInput,
  runCommandInput,
  resolveModelRef,
  type CommandContext,
  type CommandDef,
} from "@cozycode/commands";
import { effortsForModel } from "@cozycode/commands";
import { useApp } from "../store/app-store";
import { CommandSuggestions } from "./CommandSuggestions";
import { EffortPicker } from "./EffortPicker";
import { ModelPicker } from "./ModelPicker";
import { PermissionPill } from "./PermissionPill";
import { confirmsEscapeStop, ESCAPE_STOP_WINDOW_MS } from "./escape-stop";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// A slash-command completion is active when the whole input is one "/token".
function commandQuery(text: string): string | null {
  const match = /^\/(\S*)$/.exec(text);
  return match ? match[1]! : null;
}

export function Composer({ centered = false }: { centered?: boolean }) {
  const input = useApp((s) => s.input);
  const setInput = useApp((s) => s.setInput);
  const busy = useApp((s) => s.busy);
  const running = useApp((s) => s.running);
  const activeId = useApp((s) => s.activeId);
  const preset = useApp((s) => s.preset);
  const editingTurn = useApp((s) =>
    s.editingUserTurn?.sessionId === s.activeId ? s.editingUserTurn : null,
  );
  const setEditingTurn = useApp((s) => s.setEditingUserTurn);
  const editUserTurn = useApp((s) => s.editUserTurn);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [editText, setEditText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [stopPrimed, setStopPrimed] = useState(false);
  const stopPrimedAt = useRef<number | null>(null);
  const stopPrimeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const value = editingTurn ? editText : input;
  const query = editingTurn ? null : commandQuery(input);
  const suggestions = query === null ? [] : matchPrefix(query);
  const showSuggestions = suggestions.length > 0 && !dismissed;

  useEffect(() => {
    setSelected(0);
    setDismissed(false);
  }, [input]);

  useEffect(() => {
    if (!editingTurn) {
      setSavingEdit(false);
      return;
    }
    setEditText(editingTurn.text);
    setSavingEdit(false);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(editingTurn.text.length, editingTurn.text.length);
    });
  }, [editingTurn]);

  useEffect(() => {
    stopPrimedAt.current = null;
    if (stopPrimeTimer.current) clearTimeout(stopPrimeTimer.current);
    stopPrimeTimer.current = null;
    setStopPrimed(false);
    if (!busy || centered) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape"
        || event.repeat
        || event.isComposing
        || event.defaultPrevented
        || event.metaKey
        || event.ctrlKey
        || event.altKey
        || event.shiftKey
      ) return;

      const target = event.target as Element | null;
      if (target?.closest('.xterm, [role="dialog"], [role="menu"], [role="listbox"]')) return;

      const state = useApp.getState();
      if (
        state.helpOpen
        || state.modelPickerOpen
        || state.effortPickerOpen
        || state.permissionQueue.length > 0
        || state.questionQueue.length > 0
      ) return;

      event.preventDefault();
      const now = Date.now();
      if (confirmsEscapeStop(stopPrimedAt.current, now)) {
        stopPrimedAt.current = null;
        if (stopPrimeTimer.current) clearTimeout(stopPrimeTimer.current);
        stopPrimeTimer.current = null;
        setStopPrimed(false);
        state.abort();
        return;
      }

      stopPrimedAt.current = now;
      setStopPrimed(true);
      if (stopPrimeTimer.current) clearTimeout(stopPrimeTimer.current);
      stopPrimeTimer.current = setTimeout(() => {
        if (stopPrimedAt.current !== now) return;
        stopPrimedAt.current = null;
        stopPrimeTimer.current = null;
        setStopPrimed(false);
      }, ESCAPE_STOP_WINDOW_MS);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      stopPrimedAt.current = null;
      if (stopPrimeTimer.current) clearTimeout(stopPrimeTimer.current);
      stopPrimeTimer.current = null;
    };
  }, [activeId, busy, centered]);

  // Auto-size the textarea to its content (up to a cap).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  const commandCtx: CommandContext = useMemo(() => {
    const s = useApp.getState();
    return {
      setMode: (mode) => s.setMode(mode),
      newSession: () => void s.createSession(),
      openModelPicker: () => s.setModelPickerOpen(true),
      openProviderPicker: () => s.openSettings("providers"),
      setModel: (id) => {
        if (!s.providers) return s.systemNote("Provider data is not loaded.", true);
        const result = resolveModelRef(id, s.providers);
        if ("error" in result) s.systemNote(result.error, true);
        else s.setModel(result);
      },
      setEffort: (level) => {
        const efforts = effortsForModel(s.providers ?? { all: [], connected: [] }, s.model);
        if (efforts.length === 0) return s.systemNote("This model has no reasoning-effort control.", true);
        const normalized = level.toLowerCase();
        if (normalized === "default" || normalized === "") return s.setEffort(undefined);
        if (!efforts.includes(normalized)) {
          return s.systemNote(`Unknown effort "${level}". Available: ${efforts.join(", ")}.`, true);
        }
        s.setEffort(normalized);
      },
      openEffortPicker: () => {
        const efforts = effortsForModel(s.providers ?? { all: [], connected: [] }, s.model);
        if (efforts.length === 0) return s.systemNote("This model has no reasoning-effort control.", true);
        s.setEffortPickerOpen(true);
      },
      showHelp: () => s.setHelpOpen(true),
      exit: () => window.close(),
      send: (text) => void s.send(text),
      notify: (kind, text) => s.systemNote(text, kind === "error"),
    };
  }, []);

  const acceptSuggestion = (command: CommandDef) => {
    setInput(`/${command.name} `);
    textareaRef.current?.focus();
  };

  const submit = async () => {
    if (editingTurn) {
      const text = editText.trim();
      if (!text || text === editingTurn.text.trim() || savingEdit || running) return;
      setSavingEdit(true);
      try {
        await editUserTurn(editingTurn.turnId, text);
      } finally {
        setSavingEdit(false);
      }
      return;
    }
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    if (parseCommandInput(text)) {
      await runCommandInput(commandCtx, text);
      return;
    }
    await useApp.getState().send(text);
  };

  const placeholder = editingTurn
    ? "Edit your message…"
    : preset === "plan"
      ? "Research a plan (read-only)…"
      : "Do anything";
  const canSubmitEdit = Boolean(
    editingTurn
    && editText.trim()
    && editText.trim() !== editingTurn.text.trim()
    && !savingEdit
    && !running,
  );

  return (
    <div className={cn("relative w-full", centered && "mx-auto max-w-180")}>
      {showSuggestions && (
        <CommandSuggestions
          suggestions={suggestions}
          selected={selected}
          onPick={acceptSuggestion}
        />
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className={cn(
          "app-no-drag flex flex-col gap-2 rounded-2xl border border-white/10 bg-surface-raised p-3 shadow-2xl shadow-black/30 backdrop-blur-xl focus-within:border-white/20",
          editingTurn && "border-primary/35",
        )}
      >
        {editingTurn ? (
          <div className="flex items-start gap-3 border-b border-white/8 px-1 pb-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground">Editing message</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                This response and every later turn will be removed. Tool side effects are not undone.
              </p>
            </div>
            <button
              type="button"
              disabled={savingEdit}
              onClick={() => setEditingTurn(null)}
              className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={value}
          placeholder={placeholder}
          rows={1}
          onChange={(e) => editingTurn ? setEditText(e.target.value) : setInput(e.target.value)}
          className="max-h-55 w-full resize-none bg-transparent px-1 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
          onKeyDown={(e) => {
            if (editingTurn && e.key === "Escape") {
              e.preventDefault();
              if (!savingEdit) setEditingTurn(null);
              return;
            }
            if (showSuggestions) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((s) => (s + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((s) => (s - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Tab" || e.key === "Enter") {
                e.preventDefault();
                const command = suggestions[selected];
                if (command) acceptSuggestion(command);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissed(true);
                return;
              }
            }
            if (e.key === "Tab") {
              e.preventDefault();
              useApp.getState().setMode(preset === "plan" ? "build" : "plan");
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="flex items-center gap-1.5">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
              >
                <Plus className="size-4" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56">
              <p className="px-1 py-2 text-sm text-muted-foreground">
                Attachments are coming soon.
              </p>
            </PopoverContent>
          </Popover>

          <PermissionPill />

          <div className="ml-auto flex items-center gap-1">
            <ModelPicker />
            <EffortPicker />
            {editingTurn ? (
              <button
                type="submit"
                disabled={!canSubmitEdit}
                className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                aria-label="Edit and continue"
                title="Edit and continue"
              >
                {savingEdit ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
              </button>
            ) : busy ? (
              <div className="relative">
                {stopPrimed ? (
                  <div
                    id="escape-stop-hint"
                    role="status"
                    className="absolute right-0 bottom-full mb-2 whitespace-nowrap rounded-md border border-destructive/30 bg-popover/95 px-2 py-1 text-xs font-medium text-destructive shadow-md backdrop-blur-xl"
                  >
                    Esc again to stop
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => useApp.getState().abort()}
                  className={cn(
                    "flex size-8 items-center justify-center rounded-full bg-white/15 text-foreground transition-[color,background-color,box-shadow] duration-[160ms] ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-white/25",
                    stopPrimed && "bg-destructive/15 text-destructive ring-2 ring-destructive/70 ring-offset-2 ring-offset-background",
                  )}
                  aria-label={stopPrimed ? "Press Escape again to stop" : "Stop response"}
                  aria-describedby={stopPrimed ? "escape-stop-hint" : undefined}
                  title={stopPrimed ? "Press Escape again to stop" : "Stop response"}
                >
                  <Square className="size-3.5 fill-current" />
                </button>
              </div>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || running}
                className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
