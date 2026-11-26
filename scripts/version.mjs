// SPDX-License-Identifier: GPL-3.0-only
// Verifies or updates the SemVer version across every manifest and lockfile in
// the repository so package.json, package-lock.json, Cargo.toml, Cargo.lock,
// tauri.conf.json, and licenses/dependency-inventory.json never drift apart.
//
// Usage:
//   node scripts/version.mjs --check
//   node scripts/version.mjs --set <MAJOR.MINOR.PATCH[-(alpha|beta|rc).N]>
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STABLE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export const PRERELEASE_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-(?:alpha|beta|rc)\.(?:[1-9][0-9]*)$/;
export const VALID_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:alpha|beta|rc)\.(?:[1-9][0-9]*))?$/;

const CARGO_PACKAGE_RE = /(\[\[package\]\]\r?\nname = "voxelight-launcher"\r?\nversion = ")([^"]+)(")/;
const CARGO_TOML_RE = /(^\[package\][\s\S]*?^version = ")([^"]+)(")/m;

export function isPrereleaseVersion(version) {
  return PRERELEASE_SEMVER.test(version);
}

export function validateSemver(version) {
  if (typeof version !== "string" || !VALID_SEMVER.test(version)) {
    throw new Error(
      `Invalid SemVer "${version}". Expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-(alpha|beta|rc).N (e.g. 0.7.0 or 0.7.0-beta.1).`,
    );
  }
  return version;
}

export function readVersions(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const lockRoot = lock.version;
  const lockPackage = lock.packages?.[""]?.version;
  const cargoToml = CARGO_TOML_RE.exec(readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8"))?.[2];
  const cargoLock = CARGO_PACKAGE_RE.exec(readFileSync(path.join(root, "src-tauri", "Cargo.lock"), "utf8"))?.[2];
  const tauri = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
  const inventory = JSON.parse(readFileSync(path.join(root, "licenses", "dependency-inventory.json"), "utf8")).version;

  return {
    "package.json": pkg,
    "package-lock.json": lockRoot,
    "package-lock.json#packages[\"\"]": lockPackage,
    "src-tauri/Cargo.toml": cargoToml,
    "src-tauri/Cargo.lock": cargoLock,
    "src-tauri/tauri.conf.json": tauri,
    "licenses/dependency-inventory.json": inventory,
  };
}

export function checkVersions(root) {
  const versions = readVersions(root);
  const unique = [...new Set(Object.values(versions))];
  if (unique.length !== 1 || !unique[0]) {
    const details = Object.entries(versions).map(([file, ver]) => `  ${file}: ${ver ?? "<missing>"}`).join("\n");
    throw new Error(`Version mismatch across project manifests:\n${details}`);
  }
  const version = validateSemver(unique[0]);
  return { version, prerelease: isPrereleaseVersion(version), versions };
}

function replaceJsonVersion(filePath, updater) {
  const raw = readFileSync(filePath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = raw.endsWith("\n");
  const parsed = JSON.parse(raw);
  updater(parsed);
  let formatted = JSON.stringify(parsed, null, 2).replace(/\n/g, eol);
  if (trailingNewline) formatted += eol;
  writeFileSync(filePath, formatted, "utf8");
}

export function setVersions(root, nextVersion) {
  validateSemver(nextVersion);

  const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");
  const cargoToml = readFileSync(cargoTomlPath, "utf8");
  if (!CARGO_TOML_RE.test(cargoToml)) throw new Error("Could not locate [package] version in src-tauri/Cargo.toml.");

  const cargoLockPath = path.join(root, "src-tauri", "Cargo.lock");
  const cargoLock = readFileSync(cargoLockPath, "utf8");
  if (!CARGO_PACKAGE_RE.test(cargoLock)) throw new Error("Could not locate voxelight-launcher version in src-tauri/Cargo.lock.");

  replaceJsonVersion(path.join(root, "package.json"), (doc) => {
    doc.version = nextVersion;
  });
  replaceJsonVersion(path.join(root, "package-lock.json"), (doc) => {
    doc.version = nextVersion;
    if (doc.packages?.[""]) doc.packages[""].version = nextVersion;
  });
  replaceJsonVersion(path.join(root, "src-tauri", "tauri.conf.json"), (doc) => {
    doc.version = nextVersion;
  });
  replaceJsonVersion(path.join(root, "licenses", "dependency-inventory.json"), (doc) => {
    doc.version = nextVersion;
  });
  writeFileSync(cargoTomlPath, cargoToml.replace(CARGO_TOML_RE, `$1${nextVersion}$3`), "utf8");
  writeFileSync(cargoLockPath, cargoLock.replace(CARGO_PACKAGE_RE, `$1${nextVersion}$3`), "utf8");

  return checkVersions(root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const setIndex = process.argv.indexOf("--set");
  try {
    if (setIndex >= 0) {
      const target = process.argv[setIndex + 1];
      const result = setVersions(root, target);
      console.log(`Version updated to ${result.version} (${result.prerelease ? "pre-release" : "stable"}) across ${Object.keys(result.versions).length} locations.`);
    } else {
      const result = checkVersions(root);
      console.log(`Version check passed: ${result.version} (${result.prerelease ? "pre-release" : "stable"}), synchronized across ${Object.keys(result.versions).length} locations.`);
    }
  } catch (error) {
    console.error(`version: ${error.message}`);
    process.exit(1);
  }
}
