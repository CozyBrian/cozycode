import { Sidebar } from "./Sidebar";
import { ContentPanel } from "./ContentPanel";
import { TerminalDrawer } from "./TerminalDrawer";
import { MainView } from "../chat/MainView";

export function AppLayout() {
  return (
    <div className="relative flex h-screen overflow-hidden">
      <Sidebar />
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-surface-content backdrop-blur-2xl">
        <div className="min-h-0 flex-1">
          <MainView />
        </div>
        <TerminalDrawer />
      </main>
      <ContentPanel />
    </div>
  );
}
