import React from "react";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { QuickCapture } from "./features/smart-input/QuickCapture";
import { initializeTheme } from "./lib/theme";

initializeTheme();

const isQuickCapture = Boolean(window.__TAURI_INTERNALS__)
  && new URLSearchParams(window.location.search).get("quick-capture") === "1";

if (isQuickCapture) {
  document.body.classList.add("quick-capture-window");
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

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary fallback={({ error, reset }) => <RootErrorFallback error={error} reset={reset} />}>
      {isQuickCapture ? <QuickCapture /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>,
);
