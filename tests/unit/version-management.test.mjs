// SPDX-License-Identifier: GPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersions, isPrereleaseVersion, setVersions, validateSemver } from "../../scripts/version.mjs";
import { writeMetadata } from "../../scripts/release-metadata.mjs";
import { prepare } from "../../scripts/prepare-release-assets.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fixtureRepo(version = "0.6.0") {
  const dir = mkdtempSync(path.join(tmpdir(), "vx-version-test-"));
  mkdirSync(path.join(dir, "src-tauri"), { recursive: true });
  mkdirSync(path.join(dir, "licenses"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "voxelight-launcher", version }, null, 2) + "\n");
  writeFileSync(
    path.join(dir, "package-lock.json"),
    JSON.stringify({ name: "voxelight-launcher", version, packages: { "": { name: "voxelight-launcher", version } } }, null, 2) + "\n",
  );
  writeFileSync(path.join(dir, "src-tauri", "Cargo.toml"), `[package]\nname = "voxelight-launcher"\nversion = "${version}"\n`);
  writeFileSync(
    path.join(dir, "src-tauri", "Cargo.lock"),
    `[[package]]\nname = "other-dep"\nversion = "0.6.0"\n\n[[package]]\nname = "voxelight-launcher"\nversion = "${version}"\n`,
  );
  writeFileSync(path.join(dir, "src-tauri", "tauri.conf.json"), JSON.stringify({ productName: "Voxelight Launcher", version }, null, 2) + "\n");
  writeFileSync(path.join(dir, "licenses", "dependency-inventory.json"), JSON.stringify({ project: "Voxelight Launcher", version }, null, 2) + "\n");
  return dir;
}

test("current repository manifests declare one synchronized valid SemVer", () => {
  const result = checkVersions(repoRoot);
  assert.equal(result.version, JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version);
});

test("validateSemver accepts stable and alpha/beta/rc pre-releases and rejects malformed versions", () => {
  assert.equal(validateSemver("0.7.0"), "0.7.0");
  assert.equal(isPrereleaseVersion("0.7.0"), false);
  assert.equal(validateSemver("0.7.0-beta.1"), "0.7.0-beta.1");
  assert.equal(isPrereleaseVersion("0.7.0-beta.1"), true);
  assert.equal(validateSemver("1.0.0-rc.2"), "1.0.0-rc.2");
  for (const bad of ["", "v0.7.0", "0.7", "0.7.0-beta", "0.7.0-beta.0", "0.7.0-dev.1", "01.0.0"]) {
    assert.throws(() => validateSemver(bad), /Invalid SemVer/);
  }
});

test("setVersions updates all six manifest fields atomically without touching other Cargo.lock deps", () => {
  const dir = fixtureRepo("0.6.0");
  try {
    const updated = setVersions(dir, "0.7.0-beta.1");
    assert.equal(updated.version, "0.7.0-beta.1");
    assert.equal(updated.prerelease, true);
    const cargoLock = readFileSync(path.join(dir, "src-tauri", "Cargo.lock"), "utf8");
    assert.match(cargoLock, /name = "other-dep"\nversion = "0\.6\.0"/);
    assert.match(cargoLock, /name = "voxelight-launcher"\nversion = "0\.7\.0-beta\.1"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release-metadata and prepare-release-assets support explicit --prerelease builds", () => {
  const dir = fixtureRepo("0.7.0-beta.1");
  try {
    const bundle = path.join(dir, "bundle");
    mkdirSync(bundle, { recursive: true });
    const installer = path.join(bundle, "Voxelight Launcher_0.7.0-beta.1_x64-setup.exe");
    writeFileSync(installer, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(128, 1)]));
    const metaOut = path.join(dir, "meta");
    assert.throws(() => writeMetadata({ root: dir, installer, out: metaOut }), /not a stable/);
    const meta = writeMetadata({ root: dir, installer, out: metaOut, prerelease: true });
    const manifest = JSON.parse(readFileSync(meta.manifest, "utf8"));
    assert.equal(manifest.tag_name, "v0.7.0-beta.1");
    assert.equal(manifest.prerelease, true);
    assert.equal(manifest.draft, false);

    // Minimal valid single-file stored ZIP for source staging check.
    const name = Buffer.from("README.md");
    const body = Buffer.from("voxelight");
    const localHeader = Buffer.alloc(30 + name.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(body.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    name.copy(localHeader, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    name.copy(central, 46);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(localHeader.length + body.length, 16);
    const sourceDir = path.join(dir, "source");
    mkdirSync(sourceDir, { recursive: true });
    const sourceZip = path.join(sourceDir, "source.zip");
    writeFileSync(sourceZip, Buffer.concat([localHeader, body, central, eocd]));

    const stagedOut = path.join(dir, "staged");
    assert.throws(() => prepare({ version: "0.7.0-beta.1", installer: meta.installer, source: sourceZip, out: stagedOut }), /stable/);
    const staged = prepare({ version: "0.7.0-beta.1", installer: meta.installer, source: sourceZip, out: stagedOut, prerelease: true });
    assert.equal(staged.files.length, 4);
    assert.equal(staged.version, "0.7.0-beta.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
