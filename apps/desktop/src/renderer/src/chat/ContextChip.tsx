import { FolderClosed } from "lucide-react";

export function ContextChip({ project }: { project: string }) {
  return (
    <div className="mx-auto mt-3 flex w-fit items-center gap-1.5 rounded-lg border border-border bg-card/50 px-2.5 py-1 text-xs text-muted-foreground">
      <FolderClosed className="size-3.5" />
      {project}
    </div>
  );
}
