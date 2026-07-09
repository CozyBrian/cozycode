import { useApp } from "../store/app-store";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { ContextChip } from "./ContextChip";

function projectLabel(root: string | null | undefined): string {
  if (!root) return "this chat";
  const parts = root.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

export function MainView() {
  const items = useApp((s) => s.items);
  const busy = useApp((s) => s.busy);
  const sessions = useApp((s) => s.sessions);
  const activeId = useApp((s) => s.activeId);

  const active = sessions.find((s) => s.id === activeId);
  const project = projectLabel(active?.workspaceRoot ?? null);
  const empty = items.length === 0 && !busy;

  if (empty) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6">
        <div className="w-full max-w-[720px]">
          <h1 className="mb-7 text-center text-[28px] font-semibold tracking-tight text-foreground">
            What should we work on in {project}?
          </h1>
          <Composer centered />
          <ContextChip project={project} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Transcript />
      <div className="px-6 pb-5">
        <div className="mx-auto max-w-[760px]">
          <Composer />
        </div>
      </div>
    </div>
  );
}
