import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

// Keeps the trailing `maxLength` characters (so the file name/extension
// always survives) and replaces the hidden prefix with "...".
export function truncatePathStart(path: string, maxLength = 60): string {
  if (path.length <= maxLength) return path;
  return `...${path.slice(path.length - (maxLength - 3))}`;
}

// Shows just the parent folder and file name (".../traces/run1.blf" ->
// "traces/run1.blf") - the full path belongs in a tooltip/copy, not here.
export function formatPathShort(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.slice(-2).join("/");
}

// Standard IPv6 compression (RFC 5952): drop each group's leading zeros,
// collapse the single longest run of 2+ all-zero groups into "::", then
// bracket the address so the port's colon isn't mistaken for a 9th group.
// `node` is stored as "ip:port" (ip itself full-length, uncompressed, 8
// groups for IPv6) - anything with fewer than 3 colon-separated groups
// before the port is treated as IPv4 (or already-short) and left as-is.
export function formatIpPort(node: string): string {
  const parts = node.split(":");
  const port = parts[parts.length - 1];
  const groups = parts.slice(0, -1);
  if (groups.length < 3) return node;

  const shortGroups = groups.map((g) => g.replace(/^0+(?=.)/, ""));

  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= shortGroups.length; i++) {
    const isZero = i < shortGroups.length && shortGroups[i] === "0";
    if (isZero) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
      runStart = -1;
    }
  }

  let compact: string;
  if (bestLen >= 2) {
    const before = shortGroups.slice(0, bestStart).join(":");
    const after = shortGroups.slice(bestStart + bestLen).join(":");
    compact = `${before}::${after}`;
  } else {
    compact = shortGroups.join(":");
  }

  return `[${compact}]:${port}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}
