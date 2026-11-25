// SPDX-License-Identifier: GPL-3.0-only
// Release metadata and asset staging with authored local bytes only. Nothing
// here builds, signs, uploads or runs an installer.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import { installerName, projectVersion, tauriOutputName, writeMetadata, writeNew } from "../../scripts/release-metadata.mjs";
import { checkManifest, prepare, sourceName, strictJson } from "../../scripts/prepare-release-assets.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const VERSION = "0.7.0";
const INSTALLER = Buffer.from("MZ synthetic installer bytes");

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A minimal ZIP: `entries` is [[name, content, method]] with method 0 (stored) or 8 (deflated). */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text, method = 0] of entries) {
    const content = Buffer.from(text);
    const data = method === 8 ? deflateRawSync(content) : content;
    const fileName = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(content), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(content), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(header, fileName, data);
    centrals.push(central, fileName);
    offset += header.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const SOURCE = zip([["src/", ""], ["README.md", "synthetic source"], ["src/main.rs", "fn main() {}\n".repeat(20), 8]]);
const manifestFor = (bytes = INSTALLER, version = VERSION) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [{ name: installerName(version), size: bytes.length, digest: `sha256:${sha256(bytes)}` }],
});
const MANIFEST_TEXT = JSON.stringify(manifestFor());

let workspace;
let caseNumber = 0;
test.before(() => {
  workspace = mkdtempSync(join(tmpdir(), "voxelight-release-assets-"));
});
test.after(() => rmSync(workspace, { recursive: true, force: true }));

function fixture() {
  const base = join(workspace, `case-${++caseNumber} with spaces`);
  const inputs = join(base, "inputs");
  mkdirSync(inputs, { recursive: true });
  const value = {
    base,
    inputs,
    version: VERSION,
    installer: join(inputs, installerName(VERSION)),
    source: join(inputs, "reviewed-source.zip"),
    manifest: join(inputs, "update.json"),
    out: join(base, "release-assets"),
  };
  writeFileSync(value.installer, INSTALLER);
  writeFileSync(value.source, SOURCE);
  writeFileSync(value.manifest, MANIFEST_TEXT);
  return value;
}

const run = (f) => prepare({ version: f.version, installer: f.installer, source: f.source, out: f.out });
function rejected(f, pattern) {
  assert.throws(() => run(f), pattern);
  assert.equal(existsSync(f.out), false, "a rejected release left staged output");
}
const junction = (target, link) => symlinkSync(target, link, "junction");

test("stages exactly four files with the reviewed bytes and leaves the inputs unchanged", () => {
  const f = fixture();
  writeFileSync(join(f.inputs, "private-build.pdb"), "never staged");
  const before = [f.installer, f.source, f.manifest].map((file) => readFileSync(file));
  const result = run(f);
  assert.deepEqual(readdirSync(f.out).sort(), [installerName(VERSION), sourceName(VERSION), "SHA256SUMS.txt", "update.json"].sort());
  [installerName(VERSION), sourceName(VERSION), "update.json"].forEach((name, index) => {
    assert.deepEqual(readFileSync(join(f.out, name)), before[index], `${name} changed while staging`);
  });
  [f.installer, f.source, f.manifest].forEach((file, index) => assert.deepEqual(readFileSync(file), before[index]));
  assert.equal(result.version, VERSION);
  assert.equal(result.output, resolve(f.out));
  assert.equal(result.files.length, 4);
  for (const file of result.files) {
    assert.equal(file.path, join(resolve(f.out), file.name));
    const bytes = readFileSync(file.path);
    assert.equal(file.size, bytes.length);
    assert.equal(file.sha256, sha256(bytes));
  }
  assert.deepEqual(result.uploadOrder.at(-1), "update.json", "update.json must be uploaded last");
  assert.deepEqual(result.uploadOrder.slice(0, 3).sort(), [installerName(VERSION), sourceName(VERSION), "SHA256SUMS.txt"].sort());
});

test("SHA256SUMS.txt lists the three files with two spaces, LF endings and no BOM", () => {
  const f = fixture();
  run(f);
  const expected =
    `${sha256(INSTALLER)}  ${installerName(VERSION)}\n` +
    `${sha256(SOURCE)}  ${sourceName(VERSION)}\n` +
    `${sha256(Buffer.from(MANIFEST_TEXT))}  update.json\n`;
  assert.deepEqual(readFileSync(join(f.out, "SHA256SUMS.txt")), Buffer.from(expected, "utf8"));
});

test("an existing empty output directory is accepted", () => {
  const f = fixture();
  mkdirSync(f.out);
  run(f);
  assert.equal(readdirSync(f.out).length, 4);
});

test("the command line resolves relative paths from its working directory and exits nonzero on rejection", () => {
  const f = fixture();
  const script = join(root, "scripts", "prepare-release-assets.mjs");
  const ok = spawnSync(process.execPath, [script, "--version", VERSION, "--installer", join("inputs", installerName(VERSION)), "--source", join("inputs", "reviewed-source.zip"), "--out", "release-assets"], { cwd: f.base, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readdirSync(f.out).length, 4);
  assert.match(ok.stdout, /update\.json\.$/m);
  const g = fixture();
  const bad = spawnSync(process.execPath, [script, "--version", VERSION, "--installer", g.installer, "--source", join(g.inputs, "missing.zip"), "--out", g.out], { encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /nonempty file/);
  assert.equal(existsSync(g.out), false);
  const none = spawnSync(process.execPath, [script, "--version", VERSION], { encoding: "utf8" });
  assert.notEqual(none.status, 0);
  assert.match(none.stderr, /required/);
});

for (const version of ["v0.7.0", "0.7", "0.7.0.0", "0.7.0-preview", "0.7.0+build", "00.7.0", " 0.7.0", "0.7.0\n", "٠.7.0", ""]) {
  test(`rejects the noncanonical version ${JSON.stringify(version)}`, () => {
    const f = fixture();
    f.version = version;
    rejected(f, /stable three-part version/);
  });
}

test("rejects installer bytes that changed after update.json was written, even at the same length", () => {
  const f = fixture();
  const changed = Buffer.from(INSTALLER);
  changed[changed.length - 1] ^= 1;
  writeFileSync(f.installer, changed);
  rejected(f, /must match the selected file/);
});

for (const kind of ["installer", "source", "manifest"]) {
  test(`rejects a missing ${kind}`, () => {
    const f = fixture();
    unlinkSync(f[kind]);
    rejected(f, /nonempty file/);
  });
  test(`rejects an empty ${kind}`, () => {
    const f = fixture();
    writeFileSync(f[kind], "");
    rejected(f, /nonempty file/);
  });
  test(`rejects a directory as the ${kind}`, () => {
    const f = fixture();
    unlinkSync(f[kind]);
    mkdirSync(f[kind]);
    rejected(f, /nonempty file/);
  });
}

test("rejects an installer that is not named VoxelightLauncher-<version>-x64-setup.exe", () => {
  for (const name of ["Other-setup.exe", tauriOutputName(VERSION), installerName(VERSION).toLowerCase(), installerName("0.7.1")]) {
    const f = fixture();
    const renamed = join(f.inputs, name);
    renameSync(f.installer, renamed);
    f.installer = renamed;
    rejected(f, /must be named/);
  }
});

test("rejects source archives that are not readable ZIP files with data", () => {
  const cases = [
    ["not a ZIP", Buffer.from("This is not a ZIP archive."), /not a ZIP/],
    ["an empty ZIP", zip([]), /nonempty file data/],
    ["only folders and empty files", zip([["src/", ""], ["empty.txt", ""]]), /nonempty file data/],
  ];
  const unsupported = Buffer.from(SOURCE);
  unsupported.writeUInt16LE(99, 8);
  const directoryStart = SOURCE.readUInt32LE(SOURCE.length - 22 + 16);
  unsupported.writeUInt16LE(99, directoryStart + 46 + 4 + 10); // second entry (README.md) in the directory
  const short = Buffer.from(SOURCE);
  short.writeUInt32LE(0, directoryStart + 46 + 4 + 20);
  const truncated = Buffer.from(SOURCE);
  truncated.writeUInt32LE(0xffff, directoryStart + 46 + 4 + 20);
  const corrupt = Buffer.from(SOURCE);
  const deflated = corrupt.indexOf(Buffer.from("src/main.rs")) + "src/main.rs".length;
  corrupt.fill(0xff, deflated, deflated + 6);
  cases.push(
    ["an unsupported compression method", unsupported, /unsupported compression method/],
    ["a declared length beyond the readable data", short, /declared length/],
    ["an entry past the end of the archive", truncated, /truncated/],
    ["damaged deflated data", corrupt, /damaged or cannot be read|declared length/],
    ["a damaged central directory", Buffer.concat([SOURCE.subarray(0, directoryStart), Buffer.alloc(8), SOURCE.subarray(directoryStart + 8)]), /directory is damaged/],
  );
  for (const [what, bytes, pattern] of cases) {
    const f = fixture();
    writeFileSync(f.source, bytes);
    assert.throws(() => run(f), pattern, what);
    assert.equal(existsSync(f.out), false, what);
  }
});

const manifestCases = [
  ["a mismatched tag", (m) => (m.tag_name = "v0.6.9")],
  ["a tag without the v prefix", (m) => (m.tag_name = VERSION)],
  ["a draft", (m) => (m.draft = true)],
  ["a prerelease", (m) => (m.prerelease = true)],
  ["a string draft flag", (m) => (m.draft = "false")],
  ["a null prerelease flag", (m) => (m.prerelease = null)],
  ["a missing stable flag", (m) => delete m.draft],
  ["an unknown root field", (m) => (m.body = "notes")],
  ["no installer entry", (m) => (m.assets = [])],
  ["two installer entries", (m) => (m.assets = [m.assets[0], m.assets[0]])],
  ["an asset object instead of a list", (m) => (m.assets = m.assets[0])],
  ["another installer name", (m) => (m.assets[0].name = "Other-setup.exe")],
  ["the installer name in another case", (m) => (m.assets[0].name = m.assets[0].name.toUpperCase())],
  ["a wrong size", (m) => (m.assets[0].size += 1)],
  ["a string size", (m) => (m.assets[0].size = String(m.assets[0].size))],
  ["a zero size", (m) => (m.assets[0].size = 0)],
  ["a wrong digest", (m) => (m.assets[0].digest = `sha256:${"0".repeat(64)}`)],
  ["an uppercase digest", (m) => (m.assets[0].digest = m.assets[0].digest.toUpperCase())],
  ["a digest without its prefix", (m) => (m.assets[0].digest = m.assets[0].digest.slice(7))],
  ["a missing digest", (m) => delete m.assets[0].digest],
  ["an unknown installer field", (m) => (m.assets[0].url = "https://example.invalid/ignored")],
];
for (const [what, change] of manifestCases) {
  test(`rejects update.json with ${what}`, () => {
    const f = fixture();
    const value = manifestFor();
    change(value);
    writeFileSync(f.manifest, JSON.stringify(value));
    rejected(f, /update\.json/);
  });
}

test("rejects update.json that is malformed, not an object, repeats a key or uses other key cases", () => {
  const size = String(INSTALLER.length);
  const texts = [
    "not json",
    "null",
    "[]",
    "{}",
    MANIFEST_TEXT.replace('"tag_name":', '"Tag_Name":'),
    MANIFEST_TEXT.replace('"draft":false', '"draft":true,"draft":false'),
    MANIFEST_TEXT.replace(`"size":${size}`, `"size":1,"size":${size}`),
    MANIFEST_TEXT.replace(`"size":${size}`, `"size":${size}.0`),
    MANIFEST_TEXT.replace(`"size":${size}`, `"size":${size}e0`),
    MANIFEST_TEXT.replace('"draft":false', '"__proto__":{},"draft":false'),
    `${MANIFEST_TEXT} {}`,
    MANIFEST_TEXT.slice(0, -1),
    MANIFEST_TEXT.replace('"prerelease":false', `"prerelease":false,"x":${"[".repeat(9)}${"]".repeat(9)}`),
  ];
  for (const text of texts) {
    const f = fixture();
    writeFileSync(f.manifest, text);
    assert.throws(() => run(f), /update\.json/, text.slice(0, 60));
    assert.equal(existsSync(f.out), false);
  }
});

test("rejects update.json bytes with a BOM, in UTF-16 or with invalid UTF-8", () => {
  const cases = [
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(MANIFEST_TEXT)]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(MANIFEST_TEXT, "utf16le")]),
    Buffer.concat([Buffer.from([0xff]), Buffer.from(MANIFEST_TEXT)]),
  ];
  for (const bytes of cases) {
    const f = fixture();
    writeFileSync(f.manifest, bytes);
    rejected(f, /update\.json/);
  }
});

test("rejects an oversized update.json before creating output", () => {
  const f = fixture();
  writeFileSync(f.manifest, MANIFEST_TEXT + " ".repeat(64 * 1024));
  rejected(f, /larger than/);
});

test("the strict parser's own rules: nesting, reserved keys and UTF-8", () => {
  const nested = (depth) => Buffer.from(`${"[".repeat(depth)}${"]".repeat(depth)}`);
  assert.doesNotThrow(() => strictJson(nested(8)));
  assert.throws(() => strictJson(nested(9)), /nesting deeper than eight levels/);
  assert.throws(() => strictJson(Buffer.from('{"__proto__":1}')), /reserved key/);
  assert.throws(() => strictJson(Buffer.from('{"a":1,"a":1}')), /repeated or reserved key/);
  assert.throws(() => strictJson(Buffer.from([0x7b, 0xff, 0x7d])), /not valid UTF-8/);
  assert.throws(() => strictJson(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")])), /not strict JSON/);
  assert.throws(() => strictJson(Buffer.from("[1.5]")), /integers/);
  assert.throws(() => strictJson(Buffer.from("[1e3]")), /integers/);
});

test("the strict parser accepts what release-metadata writes and what the launcher reads", () => {
  const pretty = Buffer.from(`${JSON.stringify(manifestFor(), null, 2)}\n`);
  const parsed = strictJson(pretty);
  checkManifest(parsed, VERSION, { size: INSTALLER.length, sha256: sha256(INSTALLER) });
  assert.equal(Object.getPrototypeOf(parsed), null, "parsed objects carry no prototype");
  assert.deepEqual(strictJson(Buffer.from(' {"a":[1,-2,"\\u00e9\\"",true,null,{}]} ')), Object.assign(Object.create(null), { a: [1, -2, 'é"', true, null, Object.create(null)] }));
});

test("leaves a nonempty output directory and an existing output file untouched", () => {
  const f = fixture();
  mkdirSync(f.out);
  writeFileSync(join(f.out, "keep.txt"), "keep these bytes");
  assert.throws(() => run(f), /new or empty directory/);
  assert.deepEqual(readdirSync(f.out), ["keep.txt"]);
  assert.equal(readFileSync(join(f.out, "keep.txt"), "utf8"), "keep these bytes");
  const g = fixture();
  writeFileSync(g.out, "keep this file");
  assert.throws(() => run(g), /new or empty directory/);
  assert.equal(readFileSync(g.out, "utf8"), "keep this file");
});

test("rejects output inside an input folder, an input folder inside the output, or an input file as output", () => {
  const f = fixture();
  f.out = join(f.inputs, "nested-output");
  rejected(f, /must not overlap/);
  const g = fixture();
  const outer = join(g.base, "outer");
  mkdirSync(join(outer, "source"), { recursive: true });
  renameSync(g.source, join(outer, "source", "reviewed-source.zip"));
  g.source = join(outer, "source", "reviewed-source.zip");
  g.out = outer;
  assert.throws(() => run(g), /new or empty directory|must not overlap/);
  const h = fixture();
  h.out = h.installer;
  assert.throws(() => run(h), /new or empty directory/);
  assert.deepEqual(readFileSync(h.installer), INSTALLER);
  const dots = fixture();
  dots.out = join(dots.inputs, "..assets");
  rejected(dots, /must not overlap/);
  const k = fixture();
  k.out = join(k.base, "inputs-assets");
  run(k);
  assert.equal(readdirSync(k.out).length, 4, "a sibling folder sharing a name prefix does not overlap");
});

for (const kind of ["installer", "source"]) {
  test(`rejects a ${kind} reached through a junction`, () => {
    const f = fixture();
    const link = join(f.base, "input-link");
    junction(f.inputs, link);
    f[kind] = join(link, kind === "installer" ? installerName(VERSION) : "reviewed-source.zip");
    rejected(f, /links or junctions/);
  });
}

test("rejects output under a junction without writing to its target", () => {
  const f = fixture();
  const target = join(f.base, "external-output");
  mkdirSync(target);
  const link = join(f.base, "output-link");
  junction(target, link);
  f.out = join(link, "staged");
  assert.throws(() => run(f), /links or junctions/);
  assert.deepEqual(readdirSync(target), []);
});

function metadataRoot(versions = {}) {
  const base = join(workspace, `meta-${++caseNumber}`);
  mkdirSync(join(base, "src-tauri"), { recursive: true });
  const { pkg = VERSION, cargo = VERSION, tauri = VERSION } = versions;
  writeFileSync(join(base, "package.json"), JSON.stringify({ name: "fixture", version: pkg }));
  writeFileSync(join(base, "src-tauri", "Cargo.toml"), `[package]\nname = "fixture"\nversion = "${cargo}"\n\n[dependencies]\nserde = { version = "1" }\n`);
  writeFileSync(join(base, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: tauri }));
  const build = join(base, "bundle");
  mkdirSync(build);
  const installer = join(build, tauriOutputName(VERSION));
  writeFileSync(installer, INSTALLER);
  return { base, installer, out: join(base, "installer-out") };
}

test("release-metadata copies the final installer under the fixed name and writes the matching update.json", () => {
  const m = metadataRoot();
  const result = writeMetadata({ root: m.base, installer: m.installer, out: m.out });
  assert.deepEqual(readdirSync(m.out).sort(), [installerName(VERSION), "update.json"].sort());
  assert.deepEqual(readFileSync(result.installer), INSTALLER);
  assert.deepEqual(readFileSync(m.installer), INSTALLER, "the selected installer is left in place");
  const text = readFileSync(result.manifest);
  assert.equal(text.subarray(0, 1).toString(), "{", "no BOM");
  assert.deepEqual(JSON.parse(text), manifestFor());
  assert.equal(result.sha256, sha256(INSTALLER));
  // The two scripts agree: the staged installer and its manifest pass prepare.
  const out = join(m.base, "assets");
  mkdirSync(join(m.base, "source"));
  writeFileSync(join(m.base, "source", "source.zip"), SOURCE);
  prepare({ version: VERSION, installer: result.installer, source: join(m.base, "source", "source.zip"), out });
  assert.equal(readdirSync(out).length, 4);
});

test("release-metadata accepts an installer already under the fixed name", () => {
  const m = metadataRoot();
  const renamed = join(m.base, "bundle", installerName(VERSION));
  renameSync(m.installer, renamed);
  writeMetadata({ root: m.base, installer: renamed, out: m.out });
  assert.equal(readdirSync(m.out).length, 2);
});

test("release-metadata refuses another version, a non-executable, an empty file, disagreeing versions and used outputs", () => {
  const other = metadataRoot();
  const renamed = join(other.base, "bundle", tauriOutputName("0.6.9"));
  renameSync(other.installer, renamed);
  assert.throws(() => writeMetadata({ root: other.base, installer: renamed, out: other.out }), /must be the 0\.7\.0 build/);
  const text = metadataRoot();
  writeFileSync(text.installer, "not an executable");
  assert.throws(() => writeMetadata({ root: text.base, installer: text.installer, out: text.out }), /not a Windows executable/);
  const empty = metadataRoot();
  writeFileSync(empty.installer, "");
  assert.throws(() => writeMetadata({ root: empty.base, installer: empty.installer, out: empty.out }), /nonempty file/);
  for (const versions of [{ cargo: "0.7.1" }, { tauri: "0.6.0" }, { pkg: "0.7.0-beta", cargo: "0.7.0-beta", tauri: "0.7.0-beta" }]) {
    const m = metadataRoot(versions);
    assert.throws(() => writeMetadata({ root: m.base, installer: m.installer, out: m.out }), /disagree|not a stable/);
  }
  const used = metadataRoot();
  mkdirSync(used.out);
  writeFileSync(join(used.out, "keep.txt"), "keep");
  assert.throws(() => writeMetadata({ root: used.base, installer: used.installer, out: used.out }), /new or empty directory/);
  assert.deepEqual(readdirSync(used.out), ["keep.txt"]);
  const linked = metadataRoot();
  const target = join(linked.base, "elsewhere");
  mkdirSync(target);
  junction(target, join(linked.base, "link"));
  assert.throws(() => writeMetadata({ root: linked.base, installer: linked.installer, out: join(linked.base, "link", "out") }), /links or junctions/);
  assert.deepEqual(readdirSync(target), []);
  for (const m of [other, text, empty]) assert.equal(existsSync(m.out), false);
});

test("staged files are created, never written over", () => {
  const file = join(workspace, `existing-${++caseNumber}.txt`);
  writeNew(file, Buffer.from("first"));
  assert.throws(() => writeNew(file, Buffer.from("second")), /EEXIST/);
  assert.equal(readFileSync(file, "utf8"), "first");
});

test("the checkout's three version fields agree, so release-metadata can name the build", () => {
  const version = projectVersion(root, { allowPrerelease: true });
  assert.equal(version, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
});

test("the installer refuses passive downgrades and the window may open only this project's release pages", () => {
  const read = (file) => readFileSync(join(root, file), "utf8");
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(tauri.bundle.windows.allowDowngrades, false, "the update hand-off runs the installer with /P /UPDATE");
  const template = read(`src-tauri/${tauri.bundle.windows.nsis.template}`);
  assert.match(template, /!define ALLOWDOWNGRADES "\{\{allow_downgrades\}\}"/);
  // The .onInit gate itself, not a similar line elsewhere: passive and update mode abort a downgrade.
  const gate = template.match(/; Abort downgrades if they are disabled[\s\S]*?!if "\$\{ALLOWDOWNGRADES\}" == "false"([\s\S]*?)\n\s*!endif/)?.[1] ?? "";
  for (const line of ["${OrIf} $PassiveMode = 1", "${OrIf} $UpdateMode = 1", "nsis_tauri_utils::SemverCompare", "${If} $R0 = -1", "Abort"]) {
    assert.ok(gate.includes(line), `the downgrade gate checks ${line}`);
  }
  const roots = [...read("src-tauri/src/updates/mod.rs").matchAll(/Self::(?:GitHub|Gitee) => "(https:\/\/[^"]+)"/g)].map(([, url]) => url);
  assert.equal(roots.length, 2);
  const capability = JSON.parse(read("src-tauri/capabilities/default.json"));
  const opener = capability.permissions.find((entry) => typeof entry === "object" && entry.identifier === "opener:allow-open-url");
  const allowed = opener.allow.map(({ url }) => url);
  for (const base of roots) assert.ok(allowed.includes(`${base}/releases/tag/*`), `${base} release pages`);
  assert.deepEqual(allowed.filter((url) => url.includes("/releases")).sort(), roots.map((base) => `${base}/releases/tag/*`).sort());
});
