// SPDX-License-Identifier: GPL-3.0-only
import type { RemoteVersion, VersionManifest } from "../../lib/launcher";

export type VersionCategory = "release" | "snapshot" | "old" | "aprilFools";
export type VersionSort = "newest" | "oldest" | "versionDesc" | "versionAsc";
export const VERSION_CATEGORIES: readonly VersionCategory[] = ["release", "snapshot", "old", "aprilFools"];
export const VERSION_SORTS: readonly VersionSort[] = ["newest", "oldest", "versionDesc", "versionAsc"];

/** Mojang lists its April Fools versions as ordinary snapshots. */
export const APRIL_FOOLS_IDS: ReadonlySet<string> = new Set([
  "15w14a",
  "1.RV-Pre1",
  "3D Shareware v1.34",
  "20w14infinite",
  "22w13oneblockatatime",
  "23w13a_or_b",
  "24w14potato",
  "25w14craftmine",
]);

/** Snapshot, pre-release and release-candidate names since 2026 (such as `26.4-snapshot-7`). */
const MODERN_PREVIEW = /^\d+\.\d+(?:\.\d+)?-(?:snapshot|pre|rc)-\d+$/;

/** A later April Fools version: a snapshot released on 1 April (UTC) without a regular preview name. */
function aprilFools(version: RemoteVersion) {
  if (APRIL_FOOLS_IDS.has(version.id)) return true;
  const released = new Date(version.releaseTime);
  return !Number.isNaN(released.getTime()) && released.getUTCMonth() === 3 && released.getUTCDate() === 1
    && !MODERN_PREVIEW.test(version.id);
}

export function versionCategory(version: RemoteVersion): VersionCategory | null {
  switch (version.type) {
    case "release": return "release";
    case "old_beta":
    case "old_alpha": return "old";
    case "snapshot": return aprilFools(version) ? "aprilFools" : "snapshot";
    default: return null;
  }
}

/** Every listed version, plus the latest release when the list itself lacks it. */
export function catalogVersions(manifest: VersionManifest | undefined): RemoteVersion[] {
  if (!manifest) return [];
  const latest = manifest.latestRelease;
  if (!latest || manifest.versions.some(version => version.id === latest)) return manifest.versions;
  return [{ id: latest, type: "release", releaseTime: "", url: "" }, ...manifest.versions];
}

/** Preview stages, oldest first; a release comes after all of them. */
const PREVIEW_RANK: Record<string, number> = { snapshot: 0, pre: 1, prerelease: 1, rc: 2 };
/** The eras of the oldest versions: rd-, c (classic), inf-, a (alpha), b (beta). */
const ERA_RANK: Record<string, number> = { rd: 0, c: 1, inf: 2, a: 3, b: 4 };
const isNumber = (part: string) => /^\d/.test(part);
const rank = (table: Record<string, number>, part: string) => table[part.toLowerCase()];

/**
 * Order of two ids of the same naming scheme. Numbers compare as numbers and
 * separators are ignored. A preview stage (snapshot < pre < rc) comes before a
 * number at the same place, and the first part of an old id compares by era.
 * Where one id runs out, the other is newer if it goes on with a patch number
 * (1.21 < 1.21.1, c0.0.13a < c0.0.13a_03) and older if it goes on with a
 * preview stage (1.21.11-rc-1 < 1.21.11, 1.14 Pre-Release 1 < 1.14).
 */
export function compareVersionIds(a: string, b: string) {
  const parts = (id: string) => id.match(/\d+|[a-z]+/gi) ?? [];
  const left = parts(a), right = parts(b);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const x = left[index], y = right[index];
    let order: number;
    if (isNumber(x) && isNumber(y)) order = Number(x) - Number(y);
    else if (index === 0 && rank(ERA_RANK, x) !== undefined && rank(ERA_RANK, y) !== undefined) order = rank(ERA_RANK, x) - rank(ERA_RANK, y);
    else if (rank(PREVIEW_RANK, x) !== undefined && (isNumber(y) || rank(PREVIEW_RANK, y) !== undefined)) order = isNumber(y) ? -1 : rank(PREVIEW_RANK, x) - rank(PREVIEW_RANK, y);
    else if (rank(PREVIEW_RANK, y) !== undefined && isNumber(x)) order = 1;
    else order = x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0;
    if (order !== 0) return Math.sign(order);
  }
  if (left.length === right.length) return 0;
  const longerIsLeft = left.length > right.length;
  const extra = (longerIsLeft ? left : right)[Math.min(left.length, right.length)];
  const longerIsNewer = rank(PREVIEW_RANK, extra) === undefined;
  return (longerIsLeft === longerIsNewer) ? 1 : -1;
}

/** Naming schemes whose ids can be compared with each other. */
function scheme(id: string) {
  if (/^\d{2}w\d{2}/.test(id)) return "weekly";
  if (/^(?:rd-|inf-|[cab]\d)/.test(id)) return "old";
  if (/^\d+\.\d+/.test(id)) return "dotted";
  return "special";
}

function matches(version: RemoteVersion, query: string) {
  return !query || version.id.toLowerCase().includes(query);
}

const released = (version: RemoteVersion) => {
  const time = Date.parse(version.releaseTime);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
};

export function visibleVersions(
  versions: readonly RemoteVersion[],
  { category, query, sort }: { category: VersionCategory; query: string; sort: VersionSort },
): RemoteVersion[] {
  const needle = query.trim().toLowerCase();
  const list = versions.filter(version => versionCategory(version) === category && matches(version, needle));
  const byDate = (a: RemoteVersion, b: RemoteVersion) => released(a) - released(b) || compareVersionIds(a.id, b.id);
  // Weekly snapshots, dotted versions and special names have no common
  // numbering, so between schemes the version order follows the release date.
  const byVersion = (a: RemoteVersion, b: RemoteVersion) => {
    const kind = scheme(a.id);
    return kind === scheme(b.id) && kind !== "special" ? compareVersionIds(a.id, b.id) || byDate(a, b) : byDate(a, b);
  };
  const order: Record<VersionSort, (a: RemoteVersion, b: RemoteVersion) => number> = {
    newest: (a, b) => byDate(b, a),
    oldest: byDate,
    versionDesc: (a, b) => byVersion(b, a),
    versionAsc: byVersion,
  };
  return list.sort(order[sort]);
}

export function categoryCounts(versions: readonly RemoteVersion[], query: string): Record<VersionCategory, number> {
  const needle = query.trim().toLowerCase();
  const counts: Record<VersionCategory, number> = { release: 0, snapshot: 0, old: 0, aprilFools: 0 };
  for (const version of versions) {
    const category = versionCategory(version);
    if (category && matches(version, needle)) counts[category]++;
  }
  return counts;
}
