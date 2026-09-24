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
  await frame(15, 90);

  const createTaskButton = `[...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Create task")`;
  await moveCursor(createTaskButton);
  await frame(10, 90);
  await click(createTaskButton);
  await delay(250);
  await frame(12, 90);

  const launchpadButton = `[...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === "Launchpad")`;
  await moveCursor(launchpadButton);
  await frame(8, 90);
  await click(launchpadButton);
  await delay(650);
  await evaluate(`(() => {
    const browserOnlyNotice = [...document.querySelectorAll("p")]
      .find((node) => node.textContent.trim() === "Live external refresh requires the desktop app.");
    browserOnlyNotice?.remove();
  })()`);
  await frame(35, 90);

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
