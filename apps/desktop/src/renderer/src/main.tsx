import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
// Tailwind v4 + shadcn tokens first, then the existing app styles (which still
// win where they overlap, until the full UI revamp removes styles.css).
import "./globals.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
