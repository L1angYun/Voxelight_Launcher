// SPDX-License-Identifier: GPL-3.0-only

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  const kib = 1024;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GB`;
  if (bytes >= mib) return `${(bytes / mib).toFixed(1)} MB`;
  if (bytes >= kib) return `${Math.round(bytes / kib)} KB`;
  return `${Math.round(bytes)} B`;
}
