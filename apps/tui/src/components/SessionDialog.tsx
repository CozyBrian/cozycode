import type { ModelMessage } from "ai";
import type { AgentMode, ModelRef, TokenUsage } from "@cozycode/protocol";
import type { RenderItem } from "../transcript.ts";
import { DialogSelect } from "./DialogSelect.tsx";

export interface TuiSessionEntry {
  id: string;
  title: string;
  history: RenderItem[];
  model: ModelRef;
  mode: AgentMode;
  usage?: TokenUsage;
  coreHistory: ModelMessage[];
}

interface Props {
  sessions: TuiSessionEntry[];
  activeID: string | null;
  onSelect: (id: string) => void;
  onCancel: () => void;
}

/** Searchable in-memory session list, matching OpenCode's session switcher UX. */
export function SessionDialog({ sessions, activeID, onSelect, onCancel }: Props) {
  return (
    <DialogSelect
      title="Switch session"
      placeholder="Search sessions..."
      hint="/new creates a session"
      options={[...sessions].reverse().map((session) => ({
        value: session.id,
        title: session.title,
        description: `${session.model.modelID} · ${session.mode.toUpperCase()}`,
        current: session.id === activeID,
      }))}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  );
}
