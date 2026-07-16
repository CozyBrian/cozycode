import { useApp } from "../store/app-store";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { ContextChip } from "./ContextChip";
import { cn } from "@/lib/utils";

function projectLabel(root: string | null | undefined): string {
  if (!root) return "this chat";
  const parts = root.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

function ChatHeader({ title, active }: { title: string; active: boolean }) {
  const sidebarOpen = useApp((s) => s.sidebarOpen);

  return (
    <header
      className={cn(
        "app-drag relative z-40 flex h-12 shrink-0 items-center px-3",
        active && "border-b border-border/60",
      )}
    >
      <div className={cn("flex min-w-0 flex-1 items-center duration-200", !sidebarOpen && "pl-42")}>
        <div className="min-w-0 flex-1 truncate px-2 text-sm font-medium text-foreground/85">
          {title}
        </div>
      </div>
    </header>
  );
}

export function MainView() {
  const empty = useApp((s) => s.items.length === 0 && !s.busy);
  const sessions = useApp((s) => s.sessions);
  const activeId = useApp((s) => s.activeId);

  const active = sessions.find((s) => s.id === activeId);
  const project = projectLabel(active?.workspaceRoot ?? null);
  const started = !empty;
  const title = active?.title.startsWith("New session - ") ? "" : (active?.title ?? "");

  if (empty) {
    return (
      <div className="flex h-full flex-col">
        <ChatHeader title={title} active={started} />
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
          <div className="w-full max-w-180">
            <h1 className="mb-7 text-center text-[28px] font-semibold tracking-tight text-foreground">
              What should we work on in {project}?
            </h1>
            <Composer centered />
            <ContextChip project={project} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ChatHeader title={title} active={started} />
      <Transcript />
      <div className="px-6 pb-5">
        <div className="mx-auto max-w-190">
          <Composer />
        </div>
      </div>
    </div>
  );
}
