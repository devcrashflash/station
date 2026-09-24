import { readFile } from "node:fs/promises";

import { validateUpdaterManifest } from "./release-utils.mjs";

const [manifestPath, assetsPath, version] = process.argv.slice(2);
if (!manifestPath || !assetsPath || !version) {
  throw new Error("Usage: node scripts/validate-updater-manifest.mjs <latest.json> <assets.json> <version>");
}

const [manifestText, assetsText] = await Promise.all([
  readFile(manifestPath, "utf8"),
  readFile(assetsPath, "utf8"),
]);
validateUpdaterManifest(JSON.parse(manifestText), JSON.parse(assetsText), version);
console.log(`Updater manifest ${version} contains valid Intel and Apple Silicon assets.`);
