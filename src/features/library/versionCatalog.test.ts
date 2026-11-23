// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import type { RemoteVersion, VersionManifest } from "../../lib/launcher";
import { APRIL_FOOLS_IDS, catalogVersions, categoryCounts, compareVersionIds, versionCategory, visibleVersions } from "./versionCatalog";

const v = (id: string, type: string, releaseTime: string): RemoteVersion => ({ id, type, releaseTime, url: `https://piston-meta.mojang.com/${id}.json` });

// Real ids and release times from Mojang's version manifest.
const aprilFools = [
  v("15w14a", "snapshot", "2015-04-01T07:08:00+00:00"),
  v("1.RV-Pre1", "snapshot", "2016-03-31T16:18:53+00:00"),
  v("3D Shareware v1.34", "snapshot", "2019-04-01T11:18:08+00:00"),
  v("20w14infinite", "snapshot", "2020-04-01T12:47:08+00:00"),
  v("22w13oneblockatatime", "snapshot", "2022-04-01T11:56:58+00:00"),
  v("23w13a_or_b", "snapshot", "2023-04-01T12:52:18+00:00"),
  v("24w14potato", "snapshot", "2024-04-01T11:07:19+00:00"),
  v("25w14craftmine", "snapshot", "2025-04-01T15:50:09+00:00"),
];

describe("version categories", () => {
  it("knows every April Fools version Mojang lists as a snapshot", () => {
    expect([...APRIL_FOOLS_IDS].sort()).toEqual(aprilFools.map(version => version.id).sort());
    for (const version of aprilFools) expect(versionCategory(version), version.id).toBe("aprilFools");
  });

  it("treats a later weekly-style snapshot released on 1 April (UTC) as April Fools", () => {
    expect(versionCategory(v("26w14a", "snapshot", "2026-04-01T12:13:30+00:00"))).toBe("aprilFools");
  });

  it("reads 1 April in UTC whatever the local time zone", () => {
    const zone = process.env.TZ;
    try {
      // 27w14a is 31 March in UTC but 1 April far east; 27w14b is 1 April in UTC but 31 March far west.
      for (const local of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
        process.env.TZ = local;
        expect(versionCategory(v("27w14a", "snapshot", "2027-04-01T01:00:00+02:00")), local).toBe("snapshot");
        expect(versionCategory(v("27w14b", "snapshot", "2027-03-31T23:30:00-01:00")), local).toBe("aprilFools");
      }
    } finally {
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
  });

  it("keeps ordinary snapshots around 1 April, modern previews and releases in their own groups", () => {
    expect(versionCategory(v("22w13a", "snapshot", "2022-03-31T14:53:25+00:00"))).toBe("snapshot");
    expect(versionCategory(v("20w14a", "snapshot", "2020-04-02T14:28:06+00:00"))).toBe("snapshot");
    expect(versionCategory(v("27.2-snapshot-3", "snapshot", "2027-04-01T10:00:00+00:00"))).toBe("snapshot");
    expect(versionCategory(v("27.2-pre-1", "snapshot", "2027-04-01T10:00:00+00:00"))).toBe("snapshot");
    expect(versionCategory(v("27.2-rc-1", "snapshot", "2027-04-01T10:00:00+00:00"))).toBe("snapshot");
    expect(versionCategory(v("27.1.1-rc-1", "snapshot", "2027-04-01T10:00:00+00:00"))).toBe("snapshot");
    expect(versionCategory(v("26.1.1", "release", "2026-04-01T09:06:36+00:00"))).toBe("release");
    expect(versionCategory(v("28w14a", "snapshot", "not a date"))).toBe("snapshot");
  });

  it("groups old beta and alpha together and drops types Mojang does not use", () => {
    expect(versionCategory(v("b1.7.3", "old_beta", "2011-07-07T22:00:00+00:00"))).toBe("old");
    expect(versionCategory(v("a1.0.4", "old_alpha", "2010-07-08T22:00:00+00:00"))).toBe("old");
    expect(versionCategory(v("mystery", "pending", "2026-01-01T00:00:00+00:00"))).toBeNull();
  });
});

describe("version ordering", () => {
  const ascending = (ids: string[]) => expect([...ids].reverse().sort(compareVersionIds)).toEqual(ids);

  it("compares version numbers piece by piece, with a pre-release before its release", () => {
    ascending(["1.9", "1.21.2", "1.21.10", "1.21.11-rc-1", "1.21.11", "26.1", "26.1.1"]);
    expect(compareVersionIds("24w14a", "24w14b")).toBeLessThan(0);
    expect(compareVersionIds("1.21", "1.21")).toBe(0);
  });

  it("orders preview stages snapshot, pre, rc, then the release (real ids)", () => {
    ascending(["26.3-snapshot-1", "26.3-snapshot-9", "26.3-snapshot-10", "26.3-pre-1", "26.3-pre-3", "26.3-rc-1", "26.3-rc-3", "26.3"]);
    ascending(["1.14 Pre-Release 1", "1.14"]);
    ascending(["1.16-pre1", "1.16-rc1", "1.16", "1.16.1"]);
  });

  it("orders the oldest versions by era, then by number, with a _NN patch after its base (real ids)", () => {
    ascending(["rd-132211", "rd-161348", "c0.0.11a", "c0.0.13a", "c0.0.13a_03", "c0.30_01c", "inf-20100618", "a1.0.4", "a1.2.6", "b1.7.3", "b1.8", "b1.8.1"]);
  });
});

describe("visible versions", () => {
  const manifest: VersionManifest = {
    latestRelease: "1.21.1",
    latestSnapshot: "26w14a",
    versions: [
      v("26w14a", "snapshot", "2026-04-01T12:13:30+00:00"),
      v("24w14potato", "snapshot", "2024-04-01T11:07:19+00:00"),
      v("1.21.1", "release", "2024-08-08T12:24:45+00:00"),
      v("24w14a", "snapshot", "2024-04-03T12:49:39+00:00"),
      v("1.20.1", "release", "2023-06-12T13:25:51+00:00"),
      v("1.RV-Pre1", "snapshot", "2016-03-31T16:18:53+00:00"),
      v("1.9", "release", "2016-02-29T13:49:54+00:00"),
      v("b1.7.3", "old_beta", "2011-07-07T22:00:00+00:00"),
      v("a1.0.4", "old_alpha", "2010-07-08T22:00:00+00:00"),
    ],
  };
  const ids = (list: RemoteVersion[]) => list.map(version => version.id);

  it("lists one category, newest first by default", () => {
    const all = catalogVersions(manifest);
    expect(ids(visibleVersions(all, { category: "release", query: "", sort: "newest" }))).toEqual(["1.21.1", "1.20.1", "1.9"]);
    expect(ids(visibleVersions(all, { category: "snapshot", query: "", sort: "newest" }))).toEqual(["24w14a"]);
    expect(ids(visibleVersions(all, { category: "aprilFools", query: "", sort: "newest" }))).toEqual(["26w14a", "24w14potato", "1.RV-Pre1"]);
    expect(ids(visibleVersions(all, { category: "old", query: "", sort: "newest" }))).toEqual(["b1.7.3", "a1.0.4"]);
  });

  it("sorts by date either way and by version number either way", () => {
    const all = catalogVersions(manifest);
    expect(ids(visibleVersions(all, { category: "release", query: "", sort: "oldest" }))).toEqual(["1.9", "1.20.1", "1.21.1"]);
    expect(ids(visibleVersions(all, { category: "release", query: "", sort: "versionDesc" }))).toEqual(["1.21.1", "1.20.1", "1.9"]);
    expect(ids(visibleVersions(all, { category: "release", query: "", sort: "versionAsc" }))).toEqual(["1.9", "1.20.1", "1.21.1"]);
  });

  it("keeps the date and version orders apart when they disagree", () => {
    // A later fix for an older line, listed out of order.
    const fixes = [
      v("1.20", "release", "2023-06-07T09:35:22+00:00"),
      v("1.19.4", "release", "2023-07-01T00:00:00+00:00"),
      v("1.21", "release", "2024-06-13T08:24:03+00:00"),
    ];
    expect(ids(visibleVersions(fixes, { category: "release", query: "", sort: "newest" }))).toEqual(["1.21", "1.19.4", "1.20"]);
    expect(ids(visibleVersions(fixes, { category: "release", query: "", sort: "versionDesc" }))).toEqual(["1.21", "1.20", "1.19.4"]);
    expect(ids(visibleVersions(fixes, { category: "release", query: "", sort: "versionAsc" }))).toEqual(["1.19.4", "1.20", "1.21"]);
  });

  it("orders snapshots of different naming schemes by date in the version sorts (real ids)", () => {
    // 1.21.11-pre1 came out after 25w46a, though "25w…" would compare higher as an id.
    const snapshots = [
      v("25w46a", "snapshot", "2025-11-11T13:05:00+00:00"),
      v("26.3-snapshot-9", "snapshot", "2026-08-17T11:46:16+00:00"),
      v("1.21.11-rc1", "snapshot", "2025-12-04T15:20:43+00:00"),
      v("1.21.11-pre1", "snapshot", "2025-11-19T08:06:45+00:00"),
    ];
    expect(ids(visibleVersions(snapshots, { category: "snapshot", query: "", sort: "versionDesc" }))).toEqual(["26.3-snapshot-9", "1.21.11-rc1", "1.21.11-pre1", "25w46a"]);
    expect(ids(visibleVersions(snapshots, { category: "snapshot", query: "", sort: "versionAsc" }))).toEqual(["25w46a", "1.21.11-pre1", "1.21.11-rc1", "26.3-snapshot-9"]);
  });

  it("searches the ids, ignoring case and surrounding spaces, and counts matches per category", () => {
    const all = catalogVersions(manifest);
    expect(ids(visibleVersions(all, { category: "release", query: " 1.2 ", sort: "newest" }))).toEqual(["1.21.1", "1.20.1"]);
    expect(ids(visibleVersions(all, { category: "aprilFools", query: " rV ", sort: "newest" }))).toEqual(["1.RV-Pre1"]);
    expect(categoryCounts(all, "14")).toEqual({ release: 0, snapshot: 1, old: 0, aprilFools: 2 });
    expect(categoryCounts(all, " RV ")).toEqual({ release: 0, snapshot: 0, old: 0, aprilFools: 1 });
    expect(categoryCounts(all, "")).toEqual({ release: 3, snapshot: 1, old: 2, aprilFools: 3 });
  });

  it("still offers the latest release when the list itself lacks it", () => {
    const sparse: VersionManifest = { latestRelease: "1.21.1", latestSnapshot: "", versions: [] };
    expect(ids(visibleVersions(catalogVersions(sparse), { category: "release", query: "", sort: "newest" }))).toEqual(["1.21.1"]);
    expect(catalogVersions(undefined)).toEqual([]);
  });
});
