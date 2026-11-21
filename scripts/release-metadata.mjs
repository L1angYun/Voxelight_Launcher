// SPDX-License-Identifier: GPL-3.0-only
// Writes the launcher update manifest from the final installer. Run it after
// signing, because signing changes the installer's bytes. The manifest uses
// the GitHub release shape that the launcher reads:
//   {"tag_name":"v<x.y.z>","draft":false,"prerelease":false,
//    "assets":[{"name":"VoxelightLauncher-<x.y.z>-x64-setup.exe","size":<bytes>,"digest":"sha256:<hex>"}]}
// The installer is copied, never overwriting anything, under that fixed name
// without spaces, next to update.json. Nothing is uploaded, signed or run.
//
// Usage: node scripts/release-metadata.mjs --installer "<final Voxelight Launcher_<x.y.z>_x64-setup.exe>" --out <new or empty directory>
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STABLE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
/** The launcher refuses larger installers (updates::MAX_INSTALLER_BYTES). */
export const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
export const installerName = (version) => `VoxelightLauncher-${version}-x64-setup.exe`;
/** The name Tauri gives the NSIS installer (the product name contains a space). */
export const tauriOutputName = (version) => `Voxelight Launcher_${version}_x64-setup.exe`;

/** package.json, Cargo.toml and tauri.conf.json must name the same stable version. */
export function projectVersion(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const cargo = /^version = "([^"]+)"$/m.exec(readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8"))?.[1];
  const tauri = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
  if (!pkg || pkg !== cargo || pkg !== tauri) {
    throw new Error(`Version fields disagree: package.json ${pkg}, Cargo.toml ${cargo}, tauri.conf.json ${tauri}.`);
  }
  if (!STABLE.test(pkg)) throw new Error(`Version ${pkg} is not a stable three-part version.`);
  return pkg;
}

/** No existing component of `target` may be a symbolic link or junction. */
export function assertNoLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    let entry = null;
    try {
      entry = lstatSync(current);
    } catch {
      // A missing component cannot redirect anything.
    }
    if (entry?.isSymbolicLink()) throw new Error(`Release paths must not contain links or junctions: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function assertEmptyOutput(out) {
  assertNoLinks(out);
  if (existsSync(out) && (!statSync(out).isDirectory() || readdirSync(out).length > 0)) {
    throw new Error("Release output must be a new or empty directory.");
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Creates `file` and writes all of `bytes`; never replaces an existing file. */
export function writeNew(file, bytes) {
  assertNoLinks(file);
  const handle = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    for (let written = 0; written < bytes.length;) written += writeSync(handle, bytes, written);
  } finally {
    closeSync(handle);
  }
}

/** Copies the installer under its fixed name and writes update.json from the copied bytes. */
export function writeMetadata({ root, installer, out }) {
  const version = projectVersion(root);
  if (!installer || !out) throw new Error("--installer and --out are required.");
  const source = path.resolve(installer);
  const output = path.resolve(out);
  const base = path.basename(source);
  if (base !== tauriOutputName(version) && base !== installerName(version)) {
    throw new Error(`The installer must be the ${version} build (${tauriOutputName(version)}), not ${base}.`);
  }
  assertNoLinks(source);
  const stat = statSync(source, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size <= 0) throw new Error("The installer must be a nonempty file.");
  if (stat.size > MAX_INSTALLER_BYTES) throw new Error("The installer is larger than the launcher accepts (512 MiB).");
  const bytes = readFileSync(source);
  if (bytes.length !== stat.size) throw new Error("The installer changed while it was read.");
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw new Error("The installer is not a Windows executable.");
  const digest = sha256(bytes);

  assertEmptyOutput(output);
  mkdirSync(output, { recursive: true });
  const target = path.join(output, installerName(version));
  writeNew(target, bytes);
  const manifest = {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [{ name: installerName(version), size: bytes.length, digest: `sha256:${digest}` }],
  };
  const manifestPath = path.join(output, "update.json");
  writeNew(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  const copied = readFileSync(target);
  if (copied.length !== bytes.length || sha256(copied) !== digest) {
    throw new Error("The copied installer does not match the selected file.");
  }
  return { version, installer: target, manifest: manifestPath, size: bytes.length, sha256: digest };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const result = writeMetadata({ root, installer: argument("--installer"), out: argument("--out") });
    console.log(`installer: ${result.installer}`);
    console.log(`update.json: ${result.manifest}`);
    console.log(`SHA256: ${result.sha256}`);
  } catch (error) {
    console.error(`release-metadata: ${error.message}`);
    process.exit(1);
  }
}
