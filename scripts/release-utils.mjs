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

export function validateUpdaterManifest(manifest, assets, version) {
  if (manifest.version !== version) {
    throw new Error(`Updater manifest version ${JSON.stringify(manifest.version)} does not match ${version}.`);
  }

  const assetNames = new Set();
  const assetIds = new Set();
  for (const asset of assets) {
    if (typeof asset === "string") {
      assetNames.add(asset);
    } else if (asset && typeof asset.name === "string") {
      assetNames.add(asset.name);
      if (asset.id !== undefined && asset.id !== null) assetIds.add(String(asset.id));
    }
  }

  for (const platform of ["darwin-aarch64", "darwin-x86_64"]) {
    const entry = manifest.platforms?.[platform];
    if (!entry || typeof entry.signature !== "string" || !entry.signature.trim()) {
      throw new Error(`Updater manifest is missing a signature for ${platform}.`);
    }
    if (typeof entry.url !== "string") {
      throw new Error(`Updater manifest is missing a GitHub asset URL for ${platform}.`);
    }

    const assetUrl = new URL(entry.url);
    if (assetUrl.protocol !== "https:") {
      throw new Error(`Updater manifest is missing a GitHub asset URL for ${platform}.`);
    }
    if (assetUrl.hostname === "github.com") {
      const assetName = decodeURIComponent(assetUrl.pathname.split("/").at(-1));
      if (!assetNames.has(assetName)) {
        throw new Error(`Updater manifest references missing release asset ${assetName}.`);
      }
    } else if (assetUrl.hostname === "api.github.com") {
      const assetId = assetUrl.pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/)?.[1];
      if (!assetId || !assetIds.has(assetId)) {
        throw new Error(`Updater manifest references missing release asset ID ${assetId || "unknown"}.`);
      }
    } else {
      throw new Error(`Updater manifest is missing a GitHub asset URL for ${platform}.`);
    }
  }
  return manifest;
}
