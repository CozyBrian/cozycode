import { useEffect } from "react";
import { preloadHighlighter } from "@pierre/diffs";
import { useApp } from "./store/app-store";
import { useGlobalShortcuts } from "./lib/shortcuts";
import { AppLayout } from "./layout/AppLayout";
import { SettingsPage } from "./components/SettingsPage";
import { PermissionModal } from "./components/PermissionModal";
import { Help } from "./components/Help";
import { TextShimmer } from "./components/TextShimmer";
import { TooltipProvider } from "@/components/ui/tooltip";

export function App() {
  const loaded = useApp((s) => s.loaded);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const permissionQueue = useApp((s) => s.permissionQueue);
  const helpOpen = useApp((s) => s.helpOpen);
  const setHelpOpen = useApp((s) => s.setHelpOpen);
  const replyPermission = useApp((s) => s.replyPermission);

  useGlobalShortcuts();

  // Bootstrap settings + active session once.
  useEffect(() => {
    void useApp.getState().bootstrap();
    void preloadHighlighter({ themes: ["pierre-dark"], langs: ["text"] });
  }, []);

  // Subscribe to the main-process push streams for the app's lifetime.
  useEffect(() => {
    const offEvent = window.cozy.onEvent((event) => useApp.getState().applyEvent(event));
    const offSessions = window.cozy.onSessionsChanged((sessions) =>
      useApp.setState({ sessions }),
    );
    const offProviders = window.cozy.providers.onChanged((providers) =>
      useApp.setState({ providers }),
    );
    const offExit = window.cozy.term.onExit((p) => useApp.getState().closeTerm(p.termId));
    return () => {
      offEvent();
      offSessions();
      offProviders();
      offExit();
    };
  }, []);

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center">
        <TextShimmer
          className="text-2xl font-semibold tracking-tight [--base-color:var(--color-cozy-400)] [--base-gradient-color:var(--color-cozy-200)]"
          duration={1.5}
        >
          cozycode
        </TextShimmer>
      </div>
    );
  }

  return (
    <TooltipProvider>
      {settingsOpen ? <SettingsPage /> : <AppLayout />}
      {permissionQueue[0] && (
        <PermissionModal
          request={permissionQueue[0]}
          queueLength={permissionQueue.length}
          onReply={(reply, message) =>
            replyPermission(permissionQueue[0]!.id, reply, message)
          }
        />
      )}
      <Help open={helpOpen} onClose={() => setHelpOpen(false)} />
    </TooltipProvider>
  );
}
