import { useEffect, useState } from "react";
import { useApp } from "../store/app-store";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function EditUserTurnDialog() {
  const turn = useApp((state) => state.editingUserTurn);
  const setTurn = useApp((state) => state.setEditingUserTurn);
  const editTurn = useApp((state) => state.editUserTurn);
  const running = useApp((state) => state.running);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => setText(turn?.text ?? ""), [turn]);

  const submit = async () => {
    if (!turn) return;
    setSaving(true);
    try {
      if (await editTurn(turn.turnId, text)) setTurn(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={Boolean(turn)} onOpenChange={(open) => !open && !saving && setTurn(null)}>
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Edit message and continue?</DialogTitle>
          <DialogDescription>
            This response and every later turn will be permanently removed from this chat.
            Files, shell commands, and other side effects are not undone.
          </DialogDescription>
        </DialogHeader>
        <textarea
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={6}
          className="selectable w-full resize-y rounded-xl border border-border bg-background px-3 py-2.5 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-ring"
        />
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={() => setTurn(null)}>
            Cancel
          </Button>
          <Button
            disabled={saving || running || !text.trim() || text.trim() === turn?.text.trim()}
            onClick={() => void submit()}
          >
            {saving ? "Editing..." : "Edit and continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
