import { useMemo, useState } from "react";
import { RotateCcw, Search, X } from "lucide-react";
import {
  DESKTOP_COMMANDS,
  formatShortcut,
  normalizeShortcut,
  resolveShortcut,
  type DesktopCommandId,
  type ShortcutOverrides,
} from "../../../../shared/desktop-commands.ts";
import { useApp } from "../../store/app-store.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const protectedShortcuts = new Set([
  "Mod+A", "Mod+C", "Mod+H", "Mod+M", "Mod+Q", "Mod+V", "Mod+W", "Mod+X", "Mod+Z", "Mod+Shift+Z",
]);

function shortcutFromEvent(event: React.KeyboardEvent): string | null {
  const keyAliases: Record<string, string> = {
    ",": "Comma",
    "\\": "Backslash",
    "[": "BracketLeft",
    "]": "BracketRight",
  };
  const key = keyAliases[event.key] ?? (/^[a-z0-9]$/i.test(event.key) ? event.key.toUpperCase() : null);
  if (!key) return null;
  const modifiers = [
    event.metaKey || (window.cozy.platform !== "darwin" && event.ctrlKey) ? "Mod" : null,
    window.cozy.platform === "darwin" && event.ctrlKey ? "Ctrl" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
  ].filter(Boolean);
  return normalizeShortcut([...modifiers, key].join("+"));
}

export function KeyboardSection() {
  const settings = useApp((state) => state.settings);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<DesktopCommandId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const commands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? DESKTOP_COMMANDS.filter((command) => `${command.title} ${command.category}`.toLowerCase().includes(needle))
      : DESKTOP_COMMANDS;
  }, [query]);

  const saveOverrides = async (shortcutOverrides: ShortcutOverrides) => {
    const saved = await window.cozy.saveSettings({ ...(settings ?? {}), shortcutOverrides });
    useApp.getState().setSettings(saved);
  };

  const assign = async (id: DesktopCommandId, shortcut: string | null) => {
    const next: ShortcutOverrides = { ...(settings?.shortcutOverrides ?? {}) };
    const command = DESKTOP_COMMANDS.find((item) => item.id === id)!;
    const defaultShortcut = "defaultShortcut" in command ? command.defaultShortcut : null;
    if (shortcut === defaultShortcut) delete next[id];
    else next[id] = shortcut;
    await saveOverrides(next);
  };

  const capture = (id: DesktopCommandId, event: React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(null);
      setError(null);
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      void assign(id, null);
      setRecording(null);
      setError(null);
      return;
    }
    const shortcut = shortcutFromEvent(event);
    if (!shortcut) {
      setError("Use a letter, number, or supported punctuation key with Command, Control, or Option.");
      return;
    }
    if (protectedShortcuts.has(shortcut)) {
      setError(`${formatShortcut(shortcut, window.cozy.platform)} is reserved by the operating system.`);
      return;
    }
    const conflict = DESKTOP_COMMANDS.find((command) =>
      command.id !== id && resolveShortcut(command, settings?.shortcutOverrides) === shortcut
    );
    if (conflict) {
      setError(`${formatShortcut(shortcut, window.cozy.platform)} is already assigned to ${conflict.title}.`);
      return;
    }
    void assign(id, shortcut);
    setRecording(null);
    setError(null);
  };

  return (
    <section>
      <div className="mb-5 flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commands" className="pl-9" />
        </div>
        <Button variant="outline" onClick={() => void saveOverrides({})}>
          <RotateCcw className="size-4" /> Reset all
        </Button>
      </div>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="border-y border-border/70">
        {commands.map((command) => {
          const shortcut = resolveShortcut(command, settings?.shortcutOverrides);
          const custom = Object.prototype.hasOwnProperty.call(settings?.shortcutOverrides ?? {}, command.id);
          return (
            <div key={command.id} className="flex min-h-16 items-center justify-between gap-6 border-b border-border/60 py-3 last:border-b-0">
              <div className="min-w-0">
                <div className="text-sm font-medium">{command.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{command.category}{custom ? " · Customized" : ""}</div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  className="min-w-28 font-mono"
                  autoFocus={recording === command.id}
                  onClick={() => {
                    setRecording(command.id);
                    setError(null);
                  }}
                  onKeyDown={(event) => recording === command.id && capture(command.id, event)}
                >
                  {recording === command.id ? "Press shortcut…" : formatShortcut(shortcut, window.cozy.platform) || "Unassigned"}
                </Button>
                {custom && (
                  <Button variant="ghost" size="icon" aria-label={`Reset ${command.title}`} onClick={() => void assign(command.id, "defaultShortcut" in command ? command.defaultShortcut : null)}>
                    <X className="size-4" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
