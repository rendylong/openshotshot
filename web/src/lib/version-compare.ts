export type VersionParts = [number, number, number];

export function parseVersionParts(version: string): VersionParts | null {
  const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersionParts(candidate);
  const currentParts = parseVersionParts(current);
  if (!next || !currentParts) return false;
  return next.some((value, index) => value > currentParts[index] && next.slice(0, index).every((part, prevIndex) => part === currentParts[prevIndex]));
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (!pa || !pb) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (pa[index] !== pb[index]) return pa[index]! > pb[index]! ? 1 : -1;
  }
  return 0;
}
