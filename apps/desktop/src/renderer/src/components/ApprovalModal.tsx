import type { ApprovalOutcome, ApprovalRequest } from "@cozycode/protocol";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface Props {
  request: ApprovalRequest;
  onRespond: (outcome: ApprovalOutcome) => void;
}

export function ApprovalModal({ request, onRespond }: Props) {
  return (
    <Dialog open onOpenChange={(next) => !next && onRespond("deny")}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Approve action?</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-primary">{request.toolName}</span> — {request.summary}
          </DialogDescription>
        </DialogHeader>
        <pre className="selectable max-h-64 overflow-auto rounded-lg border border-border bg-card/60 p-3 font-mono text-xs text-muted-foreground">
          {JSON.stringify(request.args, null, 2)}
        </pre>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onRespond("deny")}>
            Deny
          </Button>
          <Button variant="outline" onClick={() => onRespond("allow-session")}>
            Always allow
          </Button>
          <Button onClick={() => onRespond("allow-once")}>Allow once</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
