import type { TuiSessionStatus } from "../../runtime/session-host.ts";
import type { TuiUnreadState } from "../../store/index.ts";
import { theme } from "../../theme.ts";

export interface SessionStatusPresentation {
  glyph: string;
  label: string;
  color: string;
}

export function sessionStatusPresentation(
  status: TuiSessionStatus,
  unread: TuiUnreadState = null,
): SessionStatusPresentation {
  if (status === "error" || unread === "error") {
    return { glyph: "×", label: "error", color: theme.error };
  }
  if (status === "waiting") {
    return { glyph: "◆", label: "waiting", color: theme.warning };
  }
  if (status === "running") {
    return { glyph: "●", label: "running", color: theme.warning };
  }
  if (status === "queued") {
    return { glyph: "●", label: "queued", color: theme.warning };
  }
  if (status === "settling") {
    return { glyph: "●", label: "settling", color: theme.warning };
  }
  if (unread === "completion") {
    return { glyph: "●", label: "unread", color: theme.secondary };
  }
  return { glyph: "○", label: "ready", color: theme.muted };
}
