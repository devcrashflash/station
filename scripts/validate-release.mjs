import { readFile } from "node:fs/promises";

import { validateReleaseVersion } from "./release-utils.mjs";

const tag = process.argv[2] || process.env.GITHUB_REF_NAME || "";
const [packageJsonText, tauriConfigText, cargoToml] = await Promise.all([
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
]);
const packageJson = JSON.parse(packageJsonText);
const tauriConfig = JSON.parse(tauriConfigText);
const cargoVersion = /^version = "([^"]+)"$/m.exec(cargoToml)?.[1];

validateReleaseVersion(tag, {
  "package.json": packageJson.version,
  "tauri.conf.json": tauriConfig.version,
  "Cargo.toml": cargoVersion,
});
console.log(`Release ${tag} matches all configured versions.`);
