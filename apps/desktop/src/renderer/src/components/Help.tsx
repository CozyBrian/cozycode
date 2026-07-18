import { listCommands } from "@cozycode/commands";
import { DESKTOP_COMMANDS, formatShortcut, resolveShortcut } from "../../../shared/desktop-commands.ts";
import { useApp } from "../store/app-store.ts";
import { DESKTOP_SLASH_COMMANDS } from "../command-context.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const LOCAL_KEYS: [string, string][] = [
  ["Enter", "send message"],
  ["Shift+Enter", "newline"],
  ["Esc twice", "stop active response"],
  ["Tab", "toggle plan / build"],
];

const COMMANDS: [string, string][] = listCommands().filter((command) => DESKTOP_SLASH_COMMANDS.has(command.name)).map((command) => [
  [command.name, ...(command.aliases ?? [])].map((n) => `/${n}`).join(" "),
  command.description,
]);

export function Help({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useApp((state) => state.settings);
  const keys: [string, string][] = [
    ...LOCAL_KEYS,
    ...DESKTOP_COMMANDS.flatMap((command): [string, string][] => {
      const shortcut = formatShortcut(resolveShortcut(command, settings?.shortcutOverrides), window.cozy.platform);
      return shortcut ? [[shortcut, command.title.toLowerCase()]] : [];
    }),
  ];
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Help</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1 text-sm">
          {[...keys, ...COMMANDS].map(([key, label]) => (
            <div key={key} className="flex gap-3">
              <span className="w-32 shrink-0 font-mono text-primary">{key}</span>
              <span className="text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
