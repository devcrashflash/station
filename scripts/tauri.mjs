import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const commandIndex = args.findIndex((argument) => !argument.startsWith("-"));

if (commandIndex !== -1 && args[commandIndex] === "dev") {
  args.splice(
    commandIndex + 1,
    0,
    "--config",
    "src-tauri/tauri.dev.conf.json",
  );
}

const child = spawn("tauri", args, {
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Failed to start Tauri: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exitCode = code ?? 1;
});
