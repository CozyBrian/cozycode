import { newChatWorkspace, useApp } from "../store/app-store";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { ContextChip } from "./ContextChip";
import { cn } from "@/lib/utils";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";

function projectLabel(root: string | null | undefined): string {
  if (!root) return "this chat";
  const parts = root.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

function ChatHeader({ title, active }: { title: string; active: boolean }) {
  const sidebarOpen = useApp((s) => s.sidebarOpen);

  return (
    <header
      className={cn(
        "app-drag relative z-40 flex h-12 shrink-0 items-center px-3",
        active && "border-b border-border/60",
      )}
    >
      <div className={cn("flex min-w-0 flex-1 items-center duration-200", !sidebarOpen && "pl-42")}>
        <div className="min-w-0 flex-1 truncate px-2 text-sm font-medium text-foreground/85">
          {title}
        </div>
      </div>
    </header>
  );
}

export function MainView() {
  const empty = useApp((s) => s.items.length === 0 && !s.busy);
  const sessions = useApp((s) => s.sessions);
  const settings = useApp((s) => s.settings);
  const activeId = useApp((s) => s.activeId);
  const shouldReduceMotion = useReducedMotion();

  const active = sessions.find((s) => s.id === activeId);
  const project = projectLabel(
    active ? active.workspaceRoot : newChatWorkspace({ settings, sessions }),
  );
  const started = !empty;
  const title = active?.title.startsWith("New session - ") ? "" : (active?.title ?? "");

  return (
    <div className="flex h-full flex-col">
      <ChatHeader title={title} active={started} />
      <LayoutGroup>
        <AnimatePresence initial={false} mode="popLayout">
          {empty ? (
            <motion.div
              key="empty-chat"
              className="flex min-h-0 flex-1 flex-col items-center justify-center px-6"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: shouldReduceMotion ? 0.12 : 0.16, ease: [0.23, 1, 0.32, 1] }}
            >
              <div className="w-full max-w-180">
                <h1 className="mb-7 text-center text-[28px] font-semibold tracking-tight text-foreground">
                  What should we work on in {project}?
                </h1>
                <motion.div
                  layoutId={shouldReduceMotion ? undefined : "chat-composer"}
                  transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
                >
                  <Composer centered />
                </motion.div>
                <ContextChip project={project} />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="active-chat"
              className="flex min-h-0 flex-1 flex-col"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: shouldReduceMotion ? 0.12 : 0.16, ease: [0.23, 1, 0.32, 1] }}
            >
              <Transcript />
              <div className="px-6 pb-5">
                <motion.div
                  layoutId={shouldReduceMotion ? undefined : "chat-composer"}
                  className="mx-auto max-w-190"
                  transition={{ duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
                >
                  <Composer />
                </motion.div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </LayoutGroup>
    </div>
  );
}
