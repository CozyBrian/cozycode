import type { LucideIcon } from "lucide-react";
import { FolderOpen, KeyRound, Palette, Shield, SlidersHorizontal, TerminalSquare } from "lucide-react";
import type { SettingsSection } from "../../store/app-store";

export const SETTINGS_SECTIONS: Array<{ id: SettingsSection; label: string; description: string; icon: LucideIcon }> = [
  { id: "general", label: "General", description: "Core workspace and application preferences.", icon: SlidersHorizontal },
  { id: "providers", label: "Providers", description: "Connect the models available to your sessions.", icon: KeyRound },
  { id: "workspace", label: "Workspace", description: "Choose the default folder for new chats.", icon: FolderOpen },
  { id: "permissions", label: "Permissions", description: "Control how CozyCode asks before taking action.", icon: Shield },
  { id: "appearance", label: "Appearance", description: "Adjust the information shown in the interface.", icon: Palette },
  { id: "advanced", label: "Advanced", description: "Additional application configuration.", icon: TerminalSquare },
];
