import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { migrateLocalStorage } from "./lib/local-storage-migration";
import { migrateSettingsIfNeeded } from "./stores/settings-store";
import { App } from "./App";
import "./index.css";

// Migrate localStorage keys from old "openacpui-*" prefix before React mounts
migrateLocalStorage();

// Hydrate Zustand settings store from legacy per-key localStorage entries.
// Must run before createRoot() so components read correct initial values.
migrateSettingsIfNeeded();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
