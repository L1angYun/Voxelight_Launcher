// SPDX-License-Identifier: GPL-3.0-only
// Stages reviewed local release files for a manual upload. It never downloads,
// signs, publishes or runs anything.
//
// Inputs: the installer written by scripts/release-metadata.mjs (with the
// update.json beside it) and the source ZIP from `npm run source:package`.
// It checks that update.json describes exactly that installer, that every
// source ZIP entry can be read back at its declared length, and that the output
// is a new or empty directory apart from the inputs. Then it copies the three
// reviewed files without replacing anything, writes SHA256SUMS.txt (LF) and
// confirms that exactly those four files were staged.
//
// Upload identical files to the GitHub and Gitee release of the same tag: the
// installer, the source ZIP and SHA256SUMS.txt first, update.json last.
//
// Usage: node scripts/prepare-release-assets.mjs --version <x.y.z>
//          --installer <dir>/VoxelightLauncher-<x.y.z>-x64-setup.exe
//          --source <source zip> --out <new or empty directory>
import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { assertEmptyOutput, assertNoLinks, installerName, MAX_INSTALLER_BYTES, PRERELEASE, STABLE, writeNew } from "./release-metadata.mjs";

export const MAX_MANIFEST_BYTES = 64 * 1024;
export const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
export const sourceName = (version) => `VoxelightLauncher-${version}-source.zip`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Strict UTF-8 JSON: no BOM, no duplicate or prototype keys, integers only and
 * at most eight nested containers, so whatever passes here also passes the
 * launcher's own manifest parser.
 */
export function strictJson(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("update.json is not valid UTF-8.");
  }
  let at = 0;
  const fail = (why) => {
    throw new Error(`update.json is not strict JSON (${why} at ${at}).`);
  };
  const space = () => {
    while (at < text.length && " \t\r\n".includes(text[at])) at++;
  };
  const string = () => {
    const start = at;
    if (text[at] !== '"') fail("expected a string");
    for (at++; at < text.length && text[at] !== '"'; at++) {
      if (text[at] === "\\") at++;
    }
    if (at >= text.length) fail("unterminated string");
    at++;
    try {
      return JSON.parse(text.slice(start, at));
    } catch {
      return fail("invalid string");
    }
  };
  const value = (depth) => {
    space();
    const ch = text[at];
    if (ch === "{" || ch === "[") {
      if (depth >= 8) fail("nesting deeper than eight levels");
      at++;
      space();
      const close = ch === "{" ? "}" : "]";
      const result = ch === "{" ? Object.create(null) : [];
      if (text[at] === close) {
        at++;
        return result;
      }
      for (;;) {
        if (ch === "{") {
          space();
          const key = string();
          if (Object.hasOwn(result, key) || key === "__proto__") fail(`repeated or reserved key "${key}"`);
          space();
          if (text[at++] !== ":") fail("expected a colon");
          result[key] = value(depth + 1);
        } else {
          result.push(value(depth + 1));
        }
        space();
        const next = text[at++];
        if (next === close) return result;
        if (next !== ",") fail("expected a comma");
      }
    }
    if (ch === '"') return string();
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*))(?![0-9.eE])/.exec(text.slice(at, at + 32));
    if (!literal) fail("expected a value (numbers must be integers)");
    at += literal[0].length;
    return JSON.parse(literal[0]);
  };
  const result = value(0);
  space();
  if (at !== text.length) fail("trailing data");
  return result;
}

function exactKeys(value, keys, what) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what} must be an object.`);
  if (Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new Error(`${what} must have exactly the fields ${keys.join(", ")}.`);
  }
}

/** The manifest must describe `installer` exactly (name, size and SHA-256). */
export function checkManifest(manifest, version, installer, { prerelease = false } = {}) {
  exactKeys(manifest, ["tag_name", "draft", "prerelease", "assets"], "update.json");
  const expectedPrerelease = prerelease && PRERELEASE.test(version);
  if (manifest.tag_name !== `v${version}` || manifest.draft !== false || manifest.prerelease !== expectedPrerelease) {
    throw new Error(
      expectedPrerelease
        ? "update.json must describe the requested pre-release version."
        : "update.json must describe the requested stable, published version.",
    );
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length !== 1) {
    throw new Error("update.json must list exactly one installer.");
  }
  const [asset] = manifest.assets;
  exactKeys(asset, ["name", "size", "digest"], "The update.json installer entry");
  if (asset.name !== installerName(version) || asset.size !== installer.size || asset.digest !== `sha256:${installer.sha256}`) {
    throw new Error("update.json installer name, size and SHA-256 must match the selected file.");
  }
}

/** Every file entry of the ZIP must read back (stored or deflated) at its declared length. */
export function checkZip(data, expectedVersion) {
  try {
    let end = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
      if (data.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("The source archive is not a ZIP file.");
    const count = data.readUInt16LE(end + 10);
    let offset = data.readUInt32LE(end + 16);
    if (count === 0xffff || offset === 0xffffffff) throw new Error("ZIP64 source archives are not supported.");
    let withData = false;
    for (let n = 0; n < count; n++) {
      if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error("The source archive directory is damaged.");
      const method = data.readUInt16LE(offset + 10);
      const compressed = data.readUInt32LE(offset + 20);
      const size = data.readUInt32LE(offset + 24);
      const nameLength = data.readUInt16LE(offset + 28);
      const local = data.readUInt32LE(offset + 42);
      const name = data.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
      offset += 46 + nameLength + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
      if (name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
        throw new Error(`The source archive entry path is unsafe: ${name}`);
      }
      if (name.endsWith("/")) continue;
      if (data.readUInt32LE(local) !== 0x04034b50) throw new Error(`The source archive entry ${name} is damaged.`);
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
      if (start + compressed > data.length) throw new Error(`The source archive entry ${name} is truncated.`);
      const raw = data.subarray(start, start + compressed);
      let content;
      if (method === 0) content = raw;
      else if (method === 8) content = inflateRawSync(raw, { maxOutputLength: size + 1 });
      else throw new Error(`The source archive entry ${name} uses an unsupported compression method.`);
      if (content.length !== size) throw new Error(`The source archive entry ${name} does not match its declared length.`);
      if (expectedVersion && (name === "SOURCE_MANIFEST.json" || name.endsWith("/SOURCE_MANIFEST.json"))) {
        const parsed = JSON.parse(content.toString("utf8"));
        if (parsed?.version !== expectedVersion) {
          throw new Error(`The source archive manifest version (${parsed?.version ?? "missing"}) does not match ${expectedVersion}.`);
        }
      }
      if (size > 0) withData = true;
    }
    if (!withData) throw new Error("The source archive must hold nonempty file data.");
  } catch (error) {
    if (error instanceof RangeError || error?.code?.startsWith?.("Z_") || error?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error("The source archive is damaged or cannot be read.");
    }
    throw error;
  }
}

/** True when `child` is `parent` or inside it (case-insensitive on Windows). */
function within(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function readInput(input, limit) {
  assertNoLinks(input.path);
  const stat = statSync(input.path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size <= 0) throw new Error(`Release input must be a nonempty file: ${input.path}`);
  if (stat.size > limit) throw new Error(`Release input is larger than ${limit} bytes: ${input.path}`);
  const bytes = readFileSync(input.path);
  if (bytes.length !== stat.size) throw new Error(`Release input changed while it was read: ${input.path}`);
  return { ...input, bytes, size: bytes.length, sha256: sha256(bytes) };
}

/**
 * Validates every input before creating the output, then stages the reviewed
 * bytes (exactly those that were hashed and checked) and re-reads each staged
 * file. Returns the four staged files and the upload order.
 */
export function prepare({ version, installer, source, out, prerelease = false }) {
  const valid = typeof version === "string" && (STABLE.test(version) || (prerelease && PRERELEASE.test(version)));
  if (!valid) {
    throw new Error("Version must be a stable three-part version such as 0.7.0.");
  }
  if (!installer || !source || !out) throw new Error("--installer, --source and --out are required.");
  const installerPath = path.resolve(installer);
  const output = path.resolve(out);
  if (path.basename(installerPath) !== installerName(version)) {
    throw new Error(`The installer must be named ${installerName(version)}.`);
  }
  const selected = [
    { name: installerName(version), path: installerPath, limit: MAX_INSTALLER_BYTES },
    { name: sourceName(version), path: path.resolve(source), limit: MAX_SOURCE_BYTES },
    { name: "update.json", path: path.join(path.dirname(installerPath), "update.json"), limit: MAX_MANIFEST_BYTES },
  ];
  assertEmptyOutput(output);
  for (const input of selected) {
    const folder = path.dirname(input.path);
    if (within(output, folder) || within(folder, output)) {
      throw new Error("Release input and output directories must not overlap.");
    }
  }
  const inputs = selected.map((input) => readInput(input, input.limit));
  const [installerFile, sourceFile, manifestFile] = inputs;
  if (installerFile.bytes[0] !== 0x4d || installerFile.bytes[1] !== 0x5a) {
    throw new Error("The installer is not a Windows executable.");
  }
  checkManifest(strictJson(manifestFile.bytes), version, installerFile, { prerelease });
  checkZip(sourceFile.bytes, version);

  assertEmptyOutput(output);
  mkdirSync(output, { recursive: true });
  const files = [];
  for (const input of inputs) {
    const destination = path.join(output, input.name);
    writeNew(destination, input.bytes);
    files.push({ name: input.name, path: destination, size: input.size, sha256: input.sha256 });
  }
  const sums = Buffer.from(files.map((file) => `${file.sha256}  ${file.name}\n`).join(""), "utf8");
  const sumsPath = path.join(output, "SHA256SUMS.txt");
  writeNew(sumsPath, sums);
  files.push({ name: "SHA256SUMS.txt", path: sumsPath, size: sums.length, sha256: sha256(sums) });

  assertNoLinks(output);
  const staged = readdirSync(output).sort();
  if (staged.join("\n") !== files.map((file) => file.name).sort().join("\n")) {
    throw new Error("Release output contains unexpected files.");
  }
  for (const file of files) {
    const entry = lstatSync(file.path);
    const bytes = entry.isFile() && !entry.isSymbolicLink() ? readFileSync(file.path) : null;
    if (!bytes || bytes.length !== file.size || sha256(bytes) !== file.sha256) {
      throw new Error(`Staged file does not match its reviewed input: ${file.name}`);
    }
  }
  return {
    version,
    output,
    files,
    uploadOrder: [installerName(version), sourceName(version), "SHA256SUMS.txt", "update.json"],
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = prepare({
      version: argument("--version"),
      installer: argument("--installer"),
      source: argument("--source"),
      out: argument("--out"),
      prerelease: process.argv.includes("--prerelease"),
    });
    for (const file of result.files) console.log(`${file.sha256}  ${file.size}  ${file.path}`);
    console.log(`Upload the same files to the GitHub and Gitee release v${result.version}, in this order: ${result.uploadOrder.join(", ")}.`);
  } catch (error) {
    console.error(`prepare-release-assets: ${error.message}`);
    process.exit(1);
  }
}
