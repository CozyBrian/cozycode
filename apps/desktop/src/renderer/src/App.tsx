import { useEffect } from "react";
import { createPortal } from "react-dom";
import { preloadHighlighter } from "@pierre/diffs";
import { useApp } from "./store/app-store";
import { useGlobalShortcuts } from "./lib/shortcuts";
import { AppLayout } from "./layout/AppLayout";
import { SettingsPage } from "./components/SettingsPage";
import { PermissionModal } from "./components/PermissionModal";
import { QuestionModal } from "./components/QuestionModal";
import { Help } from "./components/Help";
import { TextShimmer } from "./components/TextShimmer";
import { TitleControls, ViewControls } from "./layout/TitleBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";

export function App() {
  const loaded = useApp((s) => s.loaded);
  const settingsOpen = useApp((s) => s.settingsOpen);
  const permissionQueue = useApp((s) => s.permissionQueue);
  const questionQueue = useApp((s) => s.questionQueue);
  const helpOpen = useApp((s) => s.helpOpen);
  const setHelpOpen = useApp((s) => s.setHelpOpen);
  const replyPermission = useApp((s) => s.replyPermission);
  const answerQuestion = useApp((s) => s.answerQuestion);
  const rejectQuestion = useApp((s) => s.rejectQuestion);

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
    const offGit = window.cozy.git.onChanged((status) => useApp.getState().setGitStatus(status));
    return () => {
      offEvent();
      offSessions();
      offProviders();
      offExit();
      offGit();
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
      {createPortal(
        <div className="fixed top-0 left-0 z-50 app-no-drag flex h-12 items-center">
          <TitleControls />
        </div>,
        document.body,
      )}
      {createPortal(
        <div className="fixed top-0 right-0 z-50 app-no-drag flex h-12 items-center">
          <ViewControls />
        </div>,
        document.body,
      )}
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
      {!permissionQueue[0] && questionQueue[0] && (
        <QuestionModal
          request={questionQueue[0]}
          onAnswer={(answers) => answerQuestion(questionQueue[0]!.id, answers)}
          onReject={() => rejectQuestion(questionQueue[0]!.id)}
        />
      )}
      <Help open={helpOpen} onClose={() => setHelpOpen(false)} />
      <Toaster theme="dark" position="bottom-right" richColors />
    </TooltipProvider>
  );
}
