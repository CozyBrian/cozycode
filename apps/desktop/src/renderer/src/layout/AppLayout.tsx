import { TitleBar } from "./TitleBar";
import { Sidebar } from "./Sidebar";
import { TerminalDrawer } from "./TerminalDrawer";
import { MainView } from "../chat/MainView";

export function AppLayout() {
  return (
    <div className="grid h-screen grid-rows-[3rem_1fr]">
      <TitleBar />
      <div className="flex min-h-0">
        <Sidebar />
        <main className="relative flex min-w-0 flex-1 flex-col bg-surface-content backdrop-blur-2xl">
          <div className="min-h-0 flex-1">
            <MainView />
          </div>
          <TerminalDrawer />
        </main>
      </div>
    </div>
  );
}
