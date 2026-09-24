export function dmgFilename(version, architecture) {
  const releaseArchitecture = architecture === "arm64" ? "aarch64" : architecture;
  return `Station_${version.replaceAll(".", "_")}_${releaseArchitecture}.dmg`;
}

const STABLE_SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FIRST_UPDATER_VERSION = [0, 10, 12];

function stableVersionParts(version) {
  return version.split(".").map(Number);
}

function isBeforeFirstUpdaterVersion(version) {
  const parts = stableVersionParts(version);
  for (let index = 0; index < FIRST_UPDATER_VERSION.length; index += 1) {
    if (parts[index] !== FIRST_UPDATER_VERSION[index]) {
      return parts[index] < FIRST_UPDATER_VERSION[index];
    }
  }
  return false;
}

export function validateReleaseVersion(tag, versions) {
  if (!STABLE_SEMVER_PATTERN.test(tag)) {
    throw new Error(`Release tag ${JSON.stringify(tag)} must be a stable x.y.z version.`);
  }
  if (isBeforeFirstUpdaterVersion(tag)) {
    throw new Error(`Release tag ${tag} predates the first updater-enabled version 0.10.12.`);
  }

  const mismatches = Object.entries(versions).filter(([, version]) => version !== tag);
  if (mismatches.length) {
    const details = mismatches.map(([source, version]) => `${source}=${version}`).join(", ");
    throw new Error(`Release tag ${tag} does not match ${details}.`);
  }
  return tag;
}

export function validateUpdaterManifest(manifest, assetNames, version) {
  if (manifest.version !== version) {
    throw new Error(`Updater manifest version ${JSON.stringify(manifest.version)} does not match ${version}.`);
  }

  for (const platform of ["darwin-aarch64", "darwin-x86_64"]) {
    const entry = manifest.platforms?.[platform];
    if (!entry || typeof entry.signature !== "string" || !entry.signature.trim()) {
      throw new Error(`Updater manifest is missing a signature for ${platform}.`);
    }
    if (typeof entry.url !== "string" || !entry.url.startsWith("https://github.com/")) {
      throw new Error(`Updater manifest is missing a GitHub asset URL for ${platform}.`);
    }
    const assetName = decodeURIComponent(new URL(entry.url).pathname.split("/").at(-1));
    if (!assetNames.has(assetName)) {
      throw new Error(`Updater manifest references missing release asset ${assetName}.`);
    }
  }
  return manifest;
}
