export function dmgFilename(version, architecture) {
  const releaseArchitecture = architecture === "arm64" ? "aarch64" : architecture;
  return `Station_${version.replaceAll(".", "_")}_${releaseArchitecture}.dmg`;
}
