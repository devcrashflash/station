// Probe only after terminal activity settles; never poll an idle terminal.
export function createTerminalDirectorySync(refresh, {
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  delay = 250,
  minimumInterval = 1000,
} = {}) {
  let timer = null;
  let disposed = false;
  let pending = false;
  let running = false;
  let lastRefresh = -Infinity;

  function request() {
    if (disposed) return;
    pending = true;
    if (running) return;
    if (timer !== null) cancel(timer);
    timer = schedule(run, Math.max(delay, minimumInterval - (now() - lastRefresh)));
  }

  async function run() {
    timer = null;
    if (disposed) return;
    pending = false;
    running = true;
    lastRefresh = now();
    try {
      await refresh();
    } catch {
      // A pane can close or exit while the probe is queued.
    } finally {
      running = false;
      if (pending && !disposed) request();
    }
  }

  return {
    request,
    dispose() {
      disposed = true;
      if (timer !== null) cancel(timer);
    },
  };
}
