import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FrontendErrorBoundary } from "@/components/FrontendErrorBoundary";
import { TrayPanel } from "@/components/tray/TrayPanel";
import { settingsApi } from "@/lib/api";
import { syncLanguageFromSettings } from "@/i18n";
import { initializeInputModality } from "@/lib/inputModality";
import "./index.css";

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});
initializeInputModality();
window.addEventListener("storage", (event) => {
  if (event.key === "language") syncLanguageFromSettings(event.newValue);
});
void settingsApi
  .get()
  .then((s) => syncLanguageFromSettings(s.language))
  .catch(console.error);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FrontendErrorBoundary>
      <QueryClientProvider client={client}>
        <ThemeProvider defaultTheme="system" storageKey="phi-theme">
          <TooltipProvider>
            <TrayPanel />
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </FrontendErrorBoundary>
  </React.StrictMode>,
);
