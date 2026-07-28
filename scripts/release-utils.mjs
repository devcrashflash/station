export function dmgFilename(version) {
  return `Station_${version.replaceAll(".", "_")}.dmg`;
}
