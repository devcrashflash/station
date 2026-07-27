import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { dmgFilename } from "./release-utils.mjs";

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);
const TAURI_CONFIG_PATH = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const CARGO_TOML_PATH = new URL("../src-tauri/Cargo.toml", import.meta.url);
const CARGO_LOCK_PATH = new URL("../src-tauri/Cargo.lock", import.meta.url);
const BUNDLE_PATH = fileURLToPath(new URL("../src-tauri/target/release/bundle", import.meta.url));

function fail(message) {
  console.error(`Release failed: ${message}`);
  process.exit(1);
}

function patchVersion(version) {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) fail(`Current version ${JSON.stringify(version)} is not valid semantic versioning.`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function replaceCargoPackageVersion(contents, packageName, currentVersion, nextVersion) {
  const marker = `name = "${packageName}"\nversion = "${currentVersion}"`;
  const replacement = `name = "${packageName}"\nversion = "${nextVersion}"`;
  const occurrences = contents.split(marker).length - 1;
  if (occurrences !== 1) {
    fail(`Expected exactly one ${packageName} ${currentVersion} package entry in Cargo.lock.`);
  }
  return contents.replace(marker, replacement);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} was terminated by ${signal}.`));
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}.`));
      else resolve();
    });
  });
}

const args = process.argv.slice(2).filter((argument) => argument !== "--");
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: pnpm release [version]\n\nWithout a version, the current patch version is increased.");
  process.exit(0);
}
if (args.length > 1) fail("Pass at most one explicit version.");
if (process.platform !== "darwin") fail("DMG releases must be built on macOS.");

const [packageJsonText, tauriConfigText, cargoToml, cargoLock] = await Promise.all([
  readFile(PACKAGE_JSON_PATH, "utf8"),
  readFile(TAURI_CONFIG_PATH, "utf8"),
  readFile(CARGO_TOML_PATH, "utf8"),
  readFile(CARGO_LOCK_PATH, "utf8"),
]);
const packageJson = JSON.parse(packageJsonText);
const tauriConfig = JSON.parse(tauriConfigText);
const cargoVersionMatch = /^version = "([^"]+)"$/m.exec(cargoToml);
if (!cargoVersionMatch) fail("Could not find the package version in src-tauri/Cargo.toml.");

const currentVersion = packageJson.version;
const configuredVersions = [tauriConfig.version, cargoVersionMatch[1]];
if (configuredVersions.some((version) => version !== currentVersion)) {
  fail(`Version files are out of sync (${[currentVersion, ...configuredVersions].join(", ")}).`);
}

const nextVersion = args[0] || patchVersion(currentVersion);
if (!SEMVER_PATTERN.test(nextVersion)) fail(`${JSON.stringify(nextVersion)} is not a valid semantic version.`);

packageJson.version = nextVersion;
tauriConfig.version = nextVersion;
const nextCargoToml = cargoToml.replace(
  `version = "${currentVersion}"`,
  `version = "${nextVersion}"`,
);
const nextCargoLock = replaceCargoPackageVersion(
  cargoLock,
  packageJson.name,
  currentVersion,
  nextVersion,
);

await Promise.all([
  writeFile(PACKAGE_JSON_PATH, `${JSON.stringify(packageJson, null, 2)}\n`),
  writeFile(TAURI_CONFIG_PATH, `${JSON.stringify(tauriConfig, null, 2)}\n`),
  writeFile(CARGO_TOML_PATH, nextCargoToml),
  writeFile(CARGO_LOCK_PATH, nextCargoLock),
]);

console.log(`Building ${packageJson.name} ${nextVersion}…`);
try {
  await run("pnpm", ["tauri", "build", "--bundles", "app"]);
} catch (error) {
  fail(error.message);
}

const appName = `${tauriConfig.productName}.app`;
const appPath = join(BUNDLE_PATH, "macos", appName);
const dmgDirectory = join(BUNDLE_PATH, "dmg");
const dmgPath = join(dmgDirectory, dmgFilename(nextVersion, process.arch));
const stagingDirectory = await mkdtemp(join(tmpdir(), "station-release-"));
let dmgError = null;

try {
  await cp(appPath, join(stagingDirectory, appName), { recursive: true });
  await symlink("/Applications", join(stagingDirectory, "Applications"), "dir");
  await mkdir(dmgDirectory, { recursive: true });
  await run("hdiutil", [
    "create",
    "-volname",
    tauriConfig.productName,
    "-srcfolder",
    stagingDirectory,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ]);
} catch (error) {
  dmgError = error;
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
if (dmgError) fail(dmgError.message);

console.log(`Release ${nextVersion} created at ${dmgPath}.`);
