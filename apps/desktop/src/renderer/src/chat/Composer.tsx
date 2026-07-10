import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Mic, Plus, Square } from "lucide-react";
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
  const preset = useApp((s) => s.preset);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const query = commandQuery(input);
  const suggestions = query === null ? [] : matchPrefix(query);
  const showSuggestions = suggestions.length > 0 && !dismissed;

  useEffect(() => {
    setSelected(0);
    setDismissed(false);
  }, [input]);

  // Auto-size the textarea to its content (up to a cap).
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [input]);

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
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    if (parseCommandInput(text)) {
      await runCommandInput(commandCtx, text);
      return;
    }
    await useApp.getState().send(text);
  };

  const placeholder = preset === "plan" ? "Research a plan (read-only)…" : "Do anything";

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
        className="app-no-drag flex flex-col gap-2 rounded-2xl border border-white/10 bg-surface-raised p-3 shadow-2xl shadow-black/30 backdrop-blur-xl focus-within:border-white/20"
      >
        <textarea
          ref={textareaRef}
          value={input}
          placeholder={placeholder}
          rows={1}
          onChange={(e) => setInput(e.target.value)}
          className="max-h-55 w-full resize-none bg-transparent px-1 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
          onKeyDown={(e) => {
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
            {busy ? (
              <button
                type="button"
                onClick={() => useApp.getState().abort()}
                className="flex size-8 items-center justify-center rounded-full bg-white/15 text-foreground transition-colors hover:bg-white/25"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim()}
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
