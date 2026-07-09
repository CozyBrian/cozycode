import { useEffect } from "react";
import { useApp } from "./store/app-store";
import { useGlobalShortcuts } from "./lib/shortcuts";
import { AppLayout } from "./layout/AppLayout";
import { SettingsDialog } from "./components/SettingsDialog";
import { ApprovalModal } from "./components/ApprovalModal";
import { Help } from "./components/Help";
import { TooltipProvider } from "@/components/ui/tooltip";

export function App() {
  const loaded = useApp((s) => s.loaded);
  const approval = useApp((s) => s.approval);
  const helpOpen = useApp((s) => s.helpOpen);
  const setHelpOpen = useApp((s) => s.setHelpOpen);
  const respondApproval = useApp((s) => s.respondApproval);

  useGlobalShortcuts();

  // Bootstrap settings + active session once.
  useEffect(() => {
    void useApp.getState().bootstrap();
  }, []);

  // Subscribe to the main-process push streams for the app's lifetime.
  useEffect(() => {
    const offEvent = window.cozy.onEvent((event) => useApp.getState().applyEvent(event));
    const offApproval = window.cozy.onApprovalRequest((req) =>
      useApp.setState({ approval: req }),
    );
    const offSessions = window.cozy.onSessionsChanged((sessions) =>
      useApp.setState({ sessions }),
    );
    const offExit = window.cozy.term.onExit((p) => useApp.getState().closeTerm(p.termId));
    return () => {
      offEvent();
      offApproval();
      offSessions();
      offExit();
    };
  }, []);

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <TooltipProvider>
      <AppLayout />
      <SettingsDialog />
      {approval && <ApprovalModal request={approval} onRespond={respondApproval} />}
      <Help open={helpOpen} onClose={() => setHelpOpen(false)} />
    </TooltipProvider>
  );
}
