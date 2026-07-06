import "./App.css";
import { Button } from "@/components/ui/button";

function App() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-sm flex-col items-center gap-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-normal">
            Dev Crash Flash AI Studio
          </h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Tauri, React, Tailwind, and shadcn/ui are ready.
          </p>
        </div>
        <Button type="button">Start building</Button>
      </div>
    </main>
  );
}

export default App;
