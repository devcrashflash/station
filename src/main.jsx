import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import "./App.css";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { WorkspaceShortcuts } from "./features/workspace/WorkspaceShortcuts";
import { initializeTheme } from "./lib/theme";

const App = lazy(() => import("./app/App"));
const QuickCapture = lazy(() => import("./features/smart-input/QuickCapture").then((module) => ({ default: module.QuickCapture })));
const TabBar = lazy(() => import("./features/workspace/TabBar").then((module) => ({ default: module.TabBar })));
const TerminalSurface = lazy(() => import("./features/workspace/TerminalSurface").then((module) => ({ default: module.TerminalSurface })));

initializeTheme();

const searchParams = new URLSearchParams(window.location.search);
const isQuickCapture = Boolean(window.__TAURI_INTERNALS__)
  && searchParams.get("quick-capture") === "1";
const surface = searchParams.get("surface") || "main";

if (isQuickCapture) {
  document.body.classList.add("quick-capture-window");
} else if (surface === "tab-bar") {
  document.body.classList.add("tab-bar-window");
} else if (surface === "terminal") {
  document.body.classList.add("terminal-window");
}

function RootErrorFallback({ error, reset }) {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <section className="grid max-w-lg gap-4 rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold">The app could not display this view</h1>
        <p className="text-sm text-muted-foreground">
          Your saved data is unchanged. Reload the interface to continue.
        </p>
        <p className="break-words rounded bg-muted p-3 font-mono text-xs text-muted-foreground">
          {error?.message || String(error)}
        </p>
        <div className="flex gap-2">
          <button className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground" type="button" onClick={reset}>
            Retry
          </button>
          <button className="rounded border px-4 py-2 text-sm" type="button" onClick={() => window.location.reload()}>
            Reload app
          </button>
        </div>
      </section>
    </main>
  );
}

const surfaceElement = isQuickCapture ? <QuickCapture /> : surface === "tab-bar" ? (
  <>
    <WorkspaceShortcuts />
    <TabBar />
  </>
) : surface === "terminal" ? (
  <>
    <WorkspaceShortcuts />
    <TerminalSurface tabId={searchParams.get("tab") || ""} />
  </>
) : (
  <>
    <WorkspaceShortcuts />
    <App />
  </>
);

const content = (
  <ErrorBoundary fallback={({ error, reset }) => <RootErrorFallback error={error} reset={reset} />}>
    <Suspense fallback={null}>{surfaceElement}</Suspense>
  </ErrorBoundary>
);

ReactDOM.createRoot(document.getElementById("root")).render(
  surface === "main" || isQuickCapture ? (
    <React.StrictMode>{content}</React.StrictMode>
  ) : content,
);
