import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = join(ROOT, "docs", "assets");
const DEMO_URL = process.env.STATION_DEMO_URL || "http://127.0.0.1:1420/?demo=readme";
const DEBUG_PORT = 9333;
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const CHROME_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

const chromePath = CHROME_PATHS.find((path) => {
  const result = spawnSync("test", ["-x", path]);
  return result.status === 0;
});

if (!chromePath) {
  throw new Error("Chrome was not found. Set CHROME_PATH to a Chromium-based browser executable.");
}

const tempDir = await mkdtemp(join(tmpdir(), "station-readme-capture-"));
const profileDir = join(tempDir, "chrome-profile");
const framesDir = join(tempDir, "frames");
await Promise.all([mkdir(OUTPUT_DIR, { recursive: true }), mkdir(framesDir)]);

const chrome = spawn(chromePath, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profileDir}`,
  "--hide-scrollbars",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
  DEMO_URL,
], { stdio: "ignore" });

let socket;
let nextCommandId = 0;
const pendingCommands = new Map();

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForDebugger() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await response.json();
      const target = targets.find((candidate) => candidate.type === "page");
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch {
      // Chrome may need a moment to expose the debugger endpoint.
    }
    await delay(100);
  }
  throw new Error("Chrome DevTools endpoint did not become available.");
}

function command(method, params = {}) {
  const id = ++nextCommandId;
  return new Promise((resolveCommand, rejectCommand) => {
    pendingCommands.set(id, { resolve: resolveCommand, reject: rejectCommand });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Browser evaluation failed.");
  }
  return result.result?.value;
}

async function screenshot(path) {
  const result = await command("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(path, Buffer.from(result.data, "base64"));
}

let frameNumber = 0;
async function frame(count = 1, pause = 100) {
  for (let index = 0; index < count; index += 1) {
    const path = join(framesDir, `frame-${String(frameNumber).padStart(4, "0")}.png`);
    await screenshot(path);
    frameNumber += 1;
    if (pause) await delay(pause);
  }
}

async function moveCursor(targetExpression) {
  await evaluate(`(() => {
    const target = ${targetExpression};
    if (!target) throw new Error("Capture target not found");
    const rect = target.getBoundingClientRect();
    let cursor = document.getElementById("readme-demo-cursor");
    if (!cursor) {
      cursor = document.createElement("div");
      cursor.id = "readme-demo-cursor";
      Object.assign(cursor.style, {
        position: "fixed",
        zIndex: "99999",
        width: "18px",
        height: "18px",
        borderRadius: "999px",
        background: "rgba(124, 58, 237, 0.92)",
        border: "3px solid white",
        boxShadow: "0 2px 9px rgba(15, 23, 42, 0.35)",
        pointerEvents: "none",
        left: "${VIEWPORT.width - 38}px",
        top: "28px",
        transition: "left 650ms ease, top 650ms ease, transform 160ms ease",
      });
      document.body.appendChild(cursor);
    }
    requestAnimationFrame(() => {
      cursor.style.left = (rect.left + rect.width / 2 - 9) + "px";
      cursor.style.top = (rect.top + rect.height / 2 - 9) + "px";
    });
  })()`);
}

async function click(targetExpression) {
  await evaluate(`(() => {
    const target = ${targetExpression};
    if (!target) throw new Error("Capture target not found");
    const cursor = document.getElementById("readme-demo-cursor");
    if (cursor) cursor.style.transform = "scale(0.72)";
    target.click();
    setTimeout(() => { if (cursor) cursor.style.transform = "scale(1)"; }, 180);
  })()`);
}

try {
  const debuggerUrl = await waitForDebugger();
  socket = new WebSocket(debuggerUrl);
  await new Promise((resolveSocket, rejectSocket) => {
    socket.addEventListener("open", resolveSocket, { once: true });
    socket.addEventListener("error", rejectSocket, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pendingCommands.has(message.id)) return;
    const pending = pendingCommands.get(message.id);
    pendingCommands.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  });

  await command("Page.enable");
  await command("Runtime.enable");
  await command("Emulation.setDeviceMetricsOverride", VIEWPORT);
  await delay(1800);
  await evaluate("document.fonts.ready");

  const heroPath = join(OUTPUT_DIR, "station-overview.png");
  await screenshot(heroPath);

  // 1. Open the global overlay and capture a pull request for the Smart Inbox.
  const workflowOverlayUrl = new URL(DEMO_URL);
  workflowOverlayUrl.searchParams.set("demo", "readme");
  workflowOverlayUrl.searchParams.set("quick-capture", "1");
  await command("Page.navigate", { url: workflowOverlayUrl.toString() });
  await command("Emulation.setDeviceMetricsOverride", VIEWPORT);
  await delay(900);
  await evaluate(`(() => {
    document.body.style.background = "linear-gradient(135deg, #e8eef8 0%, #f5f3ff 52%, #e7f5f1 100%)";
    document.body.style.display = "grid";
    document.body.style.placeItems = "center";
    const surface = document.querySelector("main");
    Object.assign(surface.style, { width: "640px", height: "228px", padding: "12px 24px" });
    const input = document.querySelector('[aria-label="Quick capture"]');
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    valueSetter.call(input, "https://github.com/launchpad-labs/orbit/pull/507");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  })()`);
  await frame(10, 80);
  const addToInboxButton = `document.querySelector('[aria-label="Add to Smart Inbox"]')`;
  await moveCursor(addToInboxButton);
  await frame(4, 80);
  await click(addToInboxButton);
  await frame(5, 80);

  // 2. Move into Station's dashboard.
  await command("Page.navigate", { url: DEMO_URL });
  await command("Emulation.setDeviceMetricsOverride", VIEWPORT);
  await delay(1000);
  await frame(10, 80);

  // 3. Promote the captured pull request into the Launchpad project.
  const createTaskButton = `[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Create task")`;
  await moveCursor(createTaskButton);
  await frame(5, 80);
  await click(createTaskButton);
  await delay(250);
  await frame(5, 80);

  const launchpadButton = `[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === "Launchpad")`;
  await moveCursor(launchpadButton);
  await frame(5, 80);
  await click(launchpadButton);
  await delay(40);
  await evaluate(`(() => {
    const notice = document.createElement("div");
    notice.id = "readme-github-fetch";
    notice.innerHTML = '<span style="display:inline-block;width:14px;height:14px;border:2px solid #a78bfa;border-top-color:#6d28d9;border-radius:999px"></span><span><strong>Fetching from GitHub</strong><br><small style="color:#64748b">Loading pull request content, changed files, and comments…</small></span>';
    Object.assign(notice.style, {
      position: "fixed", zIndex: "99998", top: "28px", left: "50%", transform: "translateX(-50%)",
      display: "flex", alignItems: "center", gap: "10px", minWidth: "360px", padding: "12px 16px",
      border: "1px solid #ddd6fe", borderRadius: "10px", background: "rgba(255,255,255,.97)",
      boxShadow: "0 12px 35px rgba(15,23,42,.18)", color: "#1e293b", font: "13px/1.35 system-ui, sans-serif"
    });
    document.body.appendChild(notice);
    notice.firstElementChild.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 700, iterations: Infinity });
  })()`);
  await frame(7, 80);
  await delay(250);
  await evaluate('document.getElementById("readme-github-fetch")?.remove()');
  await evaluate(`(() => {
    const browserOnlyNotice = [...document.querySelectorAll("p")]
      .find((node) => node.textContent.trim() === "Live external refresh requires the desktop app.");
    browserOnlyNotice?.remove();
  })()`);
  await screenshot(join(OUTPUT_DIR, "station-ai-commands.png"));
  await frame(8, 80);

  // 4. Start the prepared Codex CLI command from the task.
  const aiCommandButton = `[...document.querySelectorAll("button")].find((button) => button.textContent.includes("Implement with Codex"))`;
  await moveCursor(aiCommandButton);
  await frame(4, 80);
  await click(aiCommandButton);
  await delay(250);
  await frame(5, 80);

  const orbitWorkspaceButton = `document.querySelector('[role="dialog"] button[title="/Users/demo/Projects/orbit"]')`;
  await moveCursor(orbitWorkspaceButton);
  await frame(3, 80);
  await click(orbitWorkspaceButton);
  const wizardContinueButton = `[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === "Continue")`;
  await click(wizardContinueButton);
  await delay(250);

  const newBranchButton = `[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.includes("New Branch (codex/streamline-checkout)"))`;
  await moveCursor(newBranchButton);
  await frame(3, 80);
  await click(newBranchButton);
  await click(wizardContinueButton);
  await delay(150);
  await frame(4, 80);

  const openCodexButton = `[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === "Open Implement with Codex")`;
  await moveCursor(openCodexButton);
  await frame(3, 80);
  await click(openCodexButton);
  await delay(200);

  // 5. Finish in Station's full terminal window with the prepared prompt running.
  const terminalCommandUrl = new URL(DEMO_URL);
  terminalCommandUrl.searchParams.set("demo", "readme");
  terminalCommandUrl.searchParams.set("showcase", "terminal-command");
  await command("Page.navigate", { url: terminalCommandUrl.toString() });
  await command("Emulation.setDeviceMetricsOverride", VIEWPORT);
  await delay(700);
  await frame(24, 80);

  const palettePath = join(tempDir, "palette.png");
  const gifPath = join(OUTPUT_DIR, "station-workflow.gif");
  const framePattern = join(framesDir, "frame-%04d.png");
  const palette = spawnSync("ffmpeg", ["-y", "-framerate", "10", "-i", framePattern, "-vf", "fps=10,scale=1200:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff", palettePath], { stdio: "inherit" });
  if (palette.status !== 0) throw new Error("FFmpeg palette generation failed.");
  const gif = spawnSync("ffmpeg", ["-y", "-framerate", "10", "-i", framePattern, "-i", palettePath, "-lavfi", "fps=10,scale=1200:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle", "-loop", "0", gifPath], { stdio: "inherit" });
  if (gif.status !== 0) throw new Error("FFmpeg GIF generation failed.");

  const optimizedPath = join(tempDir, "station-workflow.gif");
  const optimize = spawnSync("gifsicle", ["-O3", "--colors", "128", gifPath, "-o", optimizedPath], { stdio: "inherit" });
  if (optimize.status === 0) {
    await writeFile(gifPath, await readFile(optimizedPath));
  }

  const settingsUrl = new URL(DEMO_URL);
  settingsUrl.searchParams.set("demo", "readme");
  await command("Page.navigate", { url: settingsUrl.toString() });
  await command("Emulation.setDeviceMetricsOverride", VIEWPORT);
  await delay(1200);
  await evaluate(`(() => {
    const button = document.querySelector('[title="Global settings"]');
    if (!button) throw new Error("Global settings button not found");
    button.click();
  })()`);
  await delay(450);
  await screenshot(join(OUTPUT_DIR, "station-connections.png"));

  for (const showcase of ["terminal", "review"]) {
    const showcaseUrl = new URL(DEMO_URL);
    showcaseUrl.searchParams.set("demo", "readme");
    showcaseUrl.searchParams.set("showcase", showcase);
    await command("Page.navigate", { url: showcaseUrl.toString() });
    await delay(900);
    await screenshot(join(OUTPUT_DIR, `station-${showcase}.png`));
  }

  const overlayUrl = new URL(DEMO_URL);
  overlayUrl.searchParams.set("demo", "readme");
  overlayUrl.searchParams.set("quick-capture", "1");
  await command("Emulation.setDeviceMetricsOverride", {
    width: 640,
    height: 228,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await command("Page.navigate", { url: overlayUrl.toString() });
  await delay(1200);
  await evaluate(`(() => {
    const input = document.querySelector('[aria-label="Quick capture"]');
    if (!input) throw new Error("Quick Capture input not found");
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    valueSetter.call(input, "Capture launch retrospective notes and route them to Launchpad");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  })()`);
  await delay(250);
  await screenshot(join(OUTPUT_DIR, "station-global-overlay.png"));

  await command("Emulation.setDeviceMetricsOverride", {
    width: 640,
    height: 480,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(`(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent.includes("AI Agents"));
    if (!button) throw new Error("AI Agents tab not found");
    button.click();
  })()`);
  await delay(500);
  await screenshot(join(OUTPUT_DIR, "station-global-agents.png"));

  const assets = await readdir(OUTPUT_DIR);
  console.log(`Captured ${assets.filter((name) => name.startsWith("station-")).join(", ")}`);
} finally {
  socket?.close();
  if (chrome.exitCode === null) {
    chrome.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => chrome.once("exit", resolveExit)),
      delay(1000),
    ]);
  }
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
