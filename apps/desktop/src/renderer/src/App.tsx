import { useEffect } from "react";
import { createPortal } from "react-dom";
import { preloadHighlighter } from "@pierre/diffs";
import { useApp } from "./store/app-store";
import { executeDesktopCommand } from "./desktop-command.ts";
import { AppLayout } from "./layout/AppLayout";
import { PermissionModal } from "./components/PermissionModal";
import { QuestionModal } from "./components/QuestionModal";
import { Help } from "./components/Help";
import { TextShimmer } from "./components/TextShimmer";
import { TitleControls, ViewControls } from "./layout/TitleBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";
import { createSessionEventBatcher } from "./event-buffer.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";

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
  const dockBadgeCount = useApp((s) =>
    Object.values(s.sessionViews).reduce(
      (count, view) => count + view.permissionQueue.length + view.questionQueue.length,
      0,
    ),
  );

  // Bootstrap settings + active session once.
  useEffect(() => {
    void useApp.getState().bootstrap();
    void preloadHighlighter({ themes: ["pierre-dark"], langs: ["text"] });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    return window.cozy.onNativeCommand((command) => {
      executeDesktopCommand(command);
    });
  }, [loaded]);

  useEffect(() => {
    window.cozy.setDockBadge(dockBadgeCount);
    return () => window.cozy.setDockBadge(0);
  }, [dockBadgeCount]);

  // Subscribe to the main-process push streams for the app's lifetime.
  useEffect(() => {
    const eventBatcher = createSessionEventBatcher((envelope) => {
      const state = useApp.getState();
      const completedInBackground =
        envelope.event.type === "finish" &&
        envelope.event.reason !== "abort" &&
        envelope.sessionId !== state.activeId;
      const failedInBackground =
        envelope.event.type === "error" && envelope.sessionId !== state.activeId;
      state.applyEvent(envelope);
      if (completedInBackground) {
        const title = state.sessions.find((session) => session.id === envelope.sessionId)?.title;
        toast.success("Response ready", {
          description:
            title && !title.startsWith("New session - ")
              ? title
              : "A background session finished.",
          action: {
            label: "View",
            onClick: () => void useApp.getState().activateSession(envelope.sessionId),
          },
        });
      } else if (failedInBackground) {
        const title = state.sessions.find((session) => session.id === envelope.sessionId)?.title;
        toast.error("Background session failed", {
          description:
            title && !title.startsWith("New session - ")
              ? title
              : envelope.event.type === "error" ? envelope.event.message : undefined,
          action: {
            label: "View",
            onClick: () => void useApp.getState().activateSession(envelope.sessionId),
          },
        });
      }
    });
    const offEvent = window.cozy.onEvent(eventBatcher.push);
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
      eventBatcher.dispose();
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
      {!settingsOpen &&
        createPortal(
          <div className="fixed top-0 right-0 z-50 app-no-drag flex h-12 items-center">
            <ViewControls />
          </div>,
          document.body,
        )}
      <AppLayout />
      {permissionQueue[0] && (
        <PermissionModal
          request={permissionQueue[0]}
          queueLength={permissionQueue.length}
          onReply={(reply, message) =>
            replyPermission(permissionQueue[0]!.id, reply, message, permissionQueue[0]!.sessionId)
          }
        />
      )}
      {!permissionQueue[0] && questionQueue[0] && (
        <QuestionModal
          request={questionQueue[0]}
          onAnswer={(answers) => answerQuestion(questionQueue[0]!.id, answers, questionQueue[0]!.sessionId)}
          onReject={() => rejectQuestion(questionQueue[0]!.id, questionQueue[0]!.sessionId)}
        />
      )}
      <Help open={helpOpen} onClose={() => setHelpOpen(false)} />
      <CommandPalette />
      <Toaster theme="dark" position="bottom-right" richColors />
    </TooltipProvider>
  );
}
