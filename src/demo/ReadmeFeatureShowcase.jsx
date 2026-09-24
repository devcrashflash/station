import { Bot, CheckCircle2, GitPullRequest, Sparkles } from "lucide-react";

import { ReviewDiff } from "@/features/pull-requests/ReviewDiff";

const REVIEW_DIFF = `diff --git a/src/checkout/CheckoutFlow.jsx b/src/checkout/CheckoutFlow.jsx
index 68d2bc1..b51e9e4 100644
--- a/src/checkout/CheckoutFlow.jsx
+++ b/src/checkout/CheckoutFlow.jsx
@@ -18,10 +18,16 @@ export function CheckoutFlow({ cart, onComplete }) {
-  const [step, setStep] = useState("details");
+  const [step, setStep] = useState("contact");
+  const [completedSteps, setCompletedSteps] = useState([]);
 
-  function continueCheckout() {
-    setStep("payment");
+  function advanceTo(nextStep) {
+    setCompletedSteps((current) => [...current, step]);
+    setStep(nextStep);
   }
 
   return (
-    <CheckoutPanel step={step} cart={cart} />
+    <CheckoutPanel
+      step={step}
+      completedSteps={completedSteps}
+      cart={cart}
+      onAdvance={advanceTo}
+    />
   );
 }`;

const TERMINAL_PANES = [
  {
    title: "dev server",
    content: [
      ["$", "pnpm dev"],
      ["", ""],
      ["green", "  VITE v7.3.6  ready in 138 ms"],
      ["", ""],
      ["cyan", "  ➜  Local:   http://127.0.0.1:1420/"],
      ["cyan", "  ➜  press h + enter to show help"],
      ["", ""],
      ["muted", "  19:32:08 [vite] hmr update /src/app/App.jsx"],
    ],
  },
  {
    title: "tests",
    content: [
      ["$", "pnpm test"],
      ["", ""],
      ["green", "✔ parses GitHub pull request links"],
      ["green", "✔ builds a unified Smart Inbox feed"],
      ["green", "✔ opens review diffs with saved drafts"],
      ["green", "✔ restores terminal pane layouts"],
      ["", ""],
      ["bold", "ℹ tests 371"],
      ["green", "ℹ pass 371"],
      ["muted", "ℹ duration_ms 429.02"],
      ["", ""],
      ["$", "git status --short"],
      ["yellow", " M src/features/checkout/CheckoutFlow.jsx"],
    ],
  },
];

export function ReadmeFeatureShowcase({ view }) {
  if (view === "terminal" || view === "terminal-command") {
    return <TerminalShowcase commandRunning={view === "terminal-command"} />;
  }
  return <ReviewShowcase />;
}

function TerminalShowcase({ commandRunning = false }) {
  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="relative flex h-8 shrink-0 items-center border-b bg-muted/70 px-3 text-xs text-muted-foreground">
        <div className="flex gap-2" aria-hidden="true">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
        </div>
        <span className="absolute inset-x-0 text-center font-medium text-foreground/80">Station by DevCrashFlash (0.10.13)</span>
      </div>

      {commandRunning ? <CodexCommandTerminal /> : (
        <section className="grid min-h-0 flex-1 grid-cols-[1.05fr_0.95fr] bg-background">
          {TERMINAL_PANES.map((pane, paneIndex) => (
            <article key={pane.title} className={`flex min-w-0 flex-col ${paneIndex === 0 ? "outline -outline-offset-1 outline-primary/55" : "opacity-65"}`}>
              <header className="terminal-pane-title">
                <span className="terminal-pane-title-text">{pane.title}</span>
                <span className="ml-auto text-[10px]">~/Projects/station</span>
              </header>
              <pre className="min-h-0 flex-1 overflow-hidden px-4 py-3 font-mono text-[13px] leading-6">
                {pane.content.map(([tone, line], index) => (
                  <div key={`${pane.title}-${index}`} className={terminalTone(tone)}>{line || " "}</div>
                ))}
              </pre>
            </article>
          ))}
        </section>
      )}

      <ReadmeWorkspaceTabBar commandRunning={commandRunning} />
    </main>
  );
}

function CodexCommandTerminal() {
  return (
    <section className="min-h-0 flex-1 overflow-hidden bg-background px-5 py-4 font-mono text-[13px] leading-6">
      <p className="font-semibold text-blue-700"><span className="mr-2 text-emerald-600">❯</span>codex 'Implement with Codex · Guard checkout transitions and preserve progress …'</p>
      <div className="mt-5 max-w-5xl rounded-md border bg-muted/20 px-4 py-3 text-foreground">
        <p className="font-semibold">OpenAI Codex</p>
        <p className="text-muted-foreground">~/Projects/orbit · codex/streamline-checkout</p>
      </div>
      <div className="mt-4 max-w-5xl border-l-2 border-primary/60 pl-4">
        <p className="font-semibold">Implement with Codex · Guard checkout transitions and preserve progress</p>
        <p className="mt-2">Implement this task with the smallest safe change. Inspect the current behavior, preserve accessibility, run the relevant tests, and summarize what changed.</p>
        <p className="mt-3 text-muted-foreground">Task: Prevent duplicate submissions, preserve completed steps, and cover the retry path.</p>
        <p className="text-muted-foreground">Source: https://github.com/launchpad-labs/orbit/pull/507 · 2 reviewer comments · 2 changed files</p>
      </div>
      <div className="mt-6 grid gap-1 text-emerald-700">
        <p>● Reading task context and repository instructions</p>
        <p>● Inspecting checkout navigation and validation states</p>
        <p className="text-blue-700">◐ Working…</p>
      </div>
      <p className="mt-6 text-xs text-muted-foreground">esc to interrupt · 92% context left</p>
    </section>
  );
}

function ReadmeWorkspaceTabBar({ commandRunning = false }) {
  return (
    <nav className="tab-bar shrink-0" aria-label="Workspace tabs">
      <div className="tab-bar-items">
        <ReadmeWorkspaceTab label="Inbox" shortcut="⌘1" main />
        {commandRunning ? (
          <ReadmeWorkspaceTab label="codex · orbit" shortcut="⌘2" active />
        ) : (
          <>
            <ReadmeWorkspaceTab label="dev server" shortcut="⌘2" />
            <ReadmeWorkspaceTab label="release-check" shortcut="⌘3" active />
          </>
        )}
        <button className="workspace-tab-add" type="button" aria-label="New terminal">
          <span className="workspace-tab-add-symbol" aria-hidden="true">+</span>
          <span className="workspace-tab-shortcut" aria-hidden="true">⌘T</span>
        </button>
      </div>
    </nav>
  );
}

function ReadmeWorkspaceTab({ label, shortcut, active = false, main = false }) {
  return (
    <div className={`workspace-tab ${main ? "workspace-tab-main" : ""} ${active ? "workspace-tab-active" : ""}`}>
      <button className="workspace-tab-select" type="button">
        <span className="workspace-tab-title">{label}</span>
        <span className="workspace-tab-shortcut" aria-hidden="true">{shortcut}</span>
      </button>
      {!main && <button className="workspace-tab-close" type="button" aria-label={`Close ${label}`}>×</button>}
    </div>
  );
}

function terminalTone(tone) {
  return {
    $: "font-semibold text-blue-700 before:mr-2 before:text-emerald-600 before:content-['❯']",
    green: "text-emerald-700",
    cyan: "text-cyan-700",
    yellow: "text-amber-700",
    muted: "text-slate-500",
    bold: "font-semibold text-slate-900",
  }[tone] || "text-slate-700";
}

function ReviewShowcase() {
  const drafts = [{
    id: "draft_demo",
    taskId: "task_review_checkout",
    kind: "inline",
    body: "Nice improvement. Could we preserve the current step when validation fails?",
    path: "src/checkout/CheckoutFlow.jsx",
    oldPath: "src/checkout/CheckoutFlow.jsx",
    newPath: "src/checkout/CheckoutFlow.jsx",
    startNewLine: 20,
    newLine: 20,
    startSide: "RIGHT",
    side: "RIGHT",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }];

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b px-6">
        <span className="flex size-9 items-center justify-center rounded-md bg-violet-100 text-violet-700"><GitPullRequest className="size-5" /></span>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">launchpad-labs/orbit · Pull request #482</p>
          <h1 className="truncate text-lg font-semibold">Streamline checkout and confirmation</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="rounded-full border bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">+12 −4</span>
          <button className="rounded-md border px-3 py-2 text-sm" type="button">Close review</button>
          <button className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground" type="button">Submit review</button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_330px] gap-5 p-5">
        <section className="flex min-h-0 flex-col gap-3">
          <div className="flex items-center rounded-md border bg-muted/20 px-4 py-3">
            <span className="font-mono text-sm font-medium">src/checkout/CheckoutFlow.jsx</span>
            <span className="ml-auto text-xs text-muted-foreground">1 of 3 files</span>
          </div>
          <div className="min-h-0 flex-1">
            <ReviewDiff
              path="src/checkout/CheckoutFlow.jsx"
              diff={REVIEW_DIFF}
              drafts={drafts}
              headSha="demo-head-sha"
              onSaveDraft={() => Promise.resolve()}
              onDeleteDraft={() => Promise.resolve()}
            />
          </div>
        </section>

        <aside className="grid content-start gap-4">
          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-4 text-emerald-600" /> Review workspace</div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">Review a checked-out branch, select exact lines, and keep drafts local until you submit.</p>
          </section>
          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-2 font-semibold"><Sparkles className="size-4 text-violet-600" /> AI Commands</div>
            <div className="mt-3 grid gap-2">
              <CommandRow icon={GitPullRequest} label="Review" source="Station" />
              <CommandRow icon={Sparkles} label="Implement with Codex" source="Codex CLI" />
              <CommandRow icon={Bot} label="Plan next steps" source="Claude CLI" />
            </div>
          </section>
          <section className="rounded-lg border bg-card p-4 shadow-sm">
            <p className="text-sm font-medium">Overall comment</p>
            <p className="mt-2 rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">Checkout is easier to follow and the progress states read well. One validation edge case remains.</p>
          </section>
        </aside>
      </div>
    </main>
  );
}

function CommandRow({ icon: Icon, label, source }) {
  return (
    <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
      <Icon className="size-4" />
      <span className="font-medium">{label}</span>
      <span className="ml-auto text-xs text-muted-foreground">{source}</span>
    </div>
  );
}
