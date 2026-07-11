import { listCommands } from "@cozycode/commands";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Keybindings are documented here; slash commands come from the shared registry
// so they never drift from what the composer parser accepts.
const KEYS: [string, string][] = [
  ["Enter", "send message"],
  ["Shift+Enter", "newline"],
  ["Tab", "toggle plan / build"],
  ["⌘B", "toggle sidebar"],
  ["⌘J", "toggle terminal"],
  ["⌘⇧T", "cycle reasoning effort"],
  ["⌘[", "back"],
  ["⌘]", "forward"],
  ["⌘N", "new chat"],
  ["⌘,", "open settings"],
];

const COMMANDS: [string, string][] = listCommands().map((command) => [
  [command.name, ...(command.aliases ?? [])].map((n) => `/${n}`).join(" "),
  command.description,
]);

export function Help({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Help</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1 text-sm">
          {[...KEYS, ...COMMANDS].map(([key, label]) => (
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
