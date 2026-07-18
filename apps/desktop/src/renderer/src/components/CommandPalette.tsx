import { useMemo } from "react";
import {
  Bot,
  Check,
  CircleAlert,
  CircleDot,
  Command as CommandIcon,
  FolderOpen,
  MessageSquare,
} from "lucide-react";
import { listCommands } from "@cozycode/commands";
import { DESKTOP_COMMANDS, formatShortcut, resolveShortcut } from "../../../shared/desktop-commands.ts";
import { useApp } from "../store/app-store.ts";
import { executeDesktopCommand } from "../desktop-command.ts";
import { DESKTOP_SLASH_COMMANDS, desktopCommandContext } from "../command-context.ts";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";

function projectName(root: string | null): string {
  if (!root) return "Chats";
  const parts = root.replace(/\/+$/, "").split("/");
  return parts.at(-1) || root;
}

export function CommandPalette() {
  const open = useApp((state) => state.commandPaletteOpen);
  const scope = useApp((state) => state.commandPaletteScope);
  const sessions = useApp((state) => state.sessions);
  const views = useApp((state) => state.sessionViews);
  const activeId = useApp((state) => state.activeId);
  const settings = useApp((state) => state.settings);
  const setOpen = useApp((state) => state.setCommandPalette);

  const topLevelSessions = useMemo(
    () => sessions.filter((session) => !session.parentID),
    [sessions],
  );
  const slashCommands = useMemo(
    () => listCommands().filter((command) => DESKTOP_SLASH_COMMANDS.has(command.name)),
    [],
  );

  const close = () => setOpen(false);
  return (
    <Dialog open={open} onOpenChange={(next) => setOpen(next, scope)}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-2xl" showCloseButton={false}>
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Search application commands and sessions.
        </DialogDescription>
        <Command className="bg-popover" loop>
          <CommandInput autoFocus placeholder={scope === "sessions" ? "Search sessions…" : "Search commands or sessions…"} />
          <CommandList className="max-h-[min(65vh,32rem)] p-1">
            <CommandEmpty>No matching commands or sessions.</CommandEmpty>
            {scope === "all" && (
              <>
                <CommandGroup heading="Application">
                  {DESKTOP_COMMANDS.filter((command) => command.id !== "palette.open").map((command) => {
                    const shortcut = formatShortcut(
                      resolveShortcut(command, settings?.shortcutOverrides),
                      window.cozy.platform,
                    );
                    return (
                      <CommandItem
                        key={command.id}
                        value={`${command.title} ${command.category} ${command.id}`}
                        onSelect={() => {
                          close();
                          executeDesktopCommand(command.id);
                        }}
                      >
                        <CommandIcon className="size-4 text-muted-foreground" />
                        <span>{command.title}</span>
                        {shortcut && <kbd className="ml-auto text-xs text-muted-foreground">{shortcut}</kbd>}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
                <CommandGroup heading="Prompt commands">
                  {slashCommands.map((command) => (
                    <CommandItem
                      key={command.name}
                      value={`${command.name} ${command.title} ${command.description} ${(command.aliases ?? []).join(" ")}`}
                      onSelect={() => {
                        close();
                        command.run(desktopCommandContext(), "");
                      }}
                    >
                      <span className="w-20 shrink-0 font-mono text-primary">/{command.name}</span>
                      <span className="truncate text-muted-foreground">{command.description}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
            <CommandGroup heading={scope === "sessions" ? "Sessions" : "Recent sessions"}>
              {topLevelSessions.map((session) => {
                const view = views[session.id];
                const waiting = Boolean(view?.permissionQueue.length || view?.questionQueue.length);
                const status = waiting ? "waiting" : view?.running ? "running" : view?.backgroundError ? "error" : view?.backgroundComplete ? "unread" : "idle";
                const StatusIcon = waiting ? CircleAlert : view?.running ? CircleDot : MessageSquare;
                return (
                  <CommandItem
                    key={session.id}
                    value={`${session.title} ${session.workspaceRoot ?? "standalone chats"} ${projectName(session.workspaceRoot)} ${session.model.providerID} ${session.model.modelID} ${session.preset} ${status}`}
                    onSelect={() => {
                      close();
                      void useApp.getState().activateSession(session.id);
                    }}
                    className="py-2.5"
                  >
                    <StatusIcon className={`size-4 ${waiting ? "text-amber-400" : view?.running ? "text-primary" : "text-muted-foreground"}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{session.title}</span>
                        {session.id === activeId && <Check className="size-3.5 text-primary" />}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                        <FolderOpen className="size-3" />
                        <span>{projectName(session.workspaceRoot)}</span>
                        <span>·</span>
                        <Bot className="size-3" />
                        <span>{session.model.modelID}</span>
                        <span>·</span>
                        <span className="uppercase">{session.preset}</span>
                        {status !== "idle" && <><span>·</span><span>{status}</span></>}
                      </div>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
          <div className="flex items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span>↑↓ navigate · ↵ open · esc close</span>
            {scope === "sessions" && (
              <button type="button" className="hover:text-foreground" onClick={() => setOpen(true, "all")}>All commands</button>
            )}
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
