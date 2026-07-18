import type { ReactNode } from "react";
import { theme } from "../../theme.ts";
import { Logo } from "../Logo.tsx";

export interface HomeViewProps {
  composer: ReactNode;
  brand?: ReactNode;
  hint?: ReactNode;
  footer?: ReactNode;
  maxComposerWidth?: number;
}

export function HomeView({
  composer,
  brand,
  hint,
  footer,
  maxComposerWidth = 76,
}: HomeViewProps) {
  return (
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <box flexGrow={1} minHeight={0} alignItems="center" paddingX={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={2} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>{brand ?? <Logo />}</box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={maxComposerWidth} paddingTop={1} flexShrink={0}>
          {composer}
        </box>
        {hint ? (
          <box width="100%" maxWidth={maxComposerWidth} alignItems="center" paddingTop={1} flexShrink={0}>
            <text fg={theme.muted}>{hint}</text>
          </box>
        ) : null}
        <box flexGrow={1} minHeight={0} />
      </box>
      {footer ? <box flexShrink={0}>{footer}</box> : null}
    </box>
  );
}
