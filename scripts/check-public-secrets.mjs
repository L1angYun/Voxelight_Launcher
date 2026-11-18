import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const CONFIG_PATHS = new Set([".cargo/config.toml", "src-tauri/.cargo/config.toml"]);
const ARCHIVE_MANIFEST = "SOURCE_MANIFEST.json";
const ARCHIVE_REQUIRED = ["package.json", "package-lock.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "scripts/check-public-secrets.mjs"];
// Only fixed output locations are outside the archive contract. A manifest
// cannot turn a build directory into a source directory by listing its files.
const ARCHIVE_OUTPUT_DIRS = ["node_modules", "dist", "src-tauri/target", "src-tauri/gen", "test-results", "playwright-report", "releases"];
const ARCHIVE_OUTPUT_FILE = "tsconfig.tsbuildinfo";
const DISABLED_PUSH_URLS = new Set(["DISABLED", "DISABLED-private-never-pushes"]);
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".zip", ".jar", ".exe", ".dll", ".pdf", ".mp4", ".webm"]);
const UUID_SOURCE = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
const CF_SOURCE = String.raw`\$2a\$10\$([./A-Za-z0-9]{53})`;
const CF_VALUE = new RegExp(CF_SOURCE + "(?![./A-Za-z0-9])", "g");
// A hostile path may append a valid body character such as the dot in .txt.
const CF_REDACT = new RegExp(CF_SOURCE, "g");
const PRIVATE_TARGETS = [
  { key: "VOXELIGHT_MS_CLIENT_ID", pattern: UUID_SOURCE, ignoreCase: true, required: true },
  { key: "VOXELIGHT_CF_API_KEY", pattern: CF_SOURCE, ignoreCase: false, required: false },
];

// Also cover prefixed env keys, Rust string declarations, command arguments,
// and Cargo's { value = "...", force = true } environment syntax.
const CLIENT_VALUE = new RegExp(
  String.raw`(?<![\w])((?:[a-z_][\w-]*)?client[_-]?id)(?![\w-])["']?(?:\s*[:=,]\s*|\s+)(?:&(?:'static\s+)?str\s*=\s*)?(?:\{[^{}]*?\bvalue\s*[:=]\s*|(?:Some|String::from)\s*\(\s*)?["']?(${UUID_SOURCE})`,
  "gi",
);

const diagnostics = new Set();
function diagnostic(path, line, key) {
  // Even a hostile filename must not turn a diagnostic into a value leak.
  const safe = value => String(value)
    .replace(new RegExp(UUID_SOURCE, "gi"), "[redacted]")
    .replace(CF_REDACT, "[redacted]")
    .replace(/[\r\n\t\0]/g, "_");
  diagnostics.add(`${safe(path)}:${line}:${safe(key)}`);
}

function fail(path, key) {
  diagnostic(path, 1, key);
  throw new Error("guard could not complete");
}

function git(root, args, { input, maxBuffer = 32 * 1024 * 1024, missing = false } = {}) {
  const result = spawnSync("git", args, { cwd: root, input, maxBuffer, windowsHide: true });
  if (missing && result.status === 1) return null;
  // Git stderr may contain file content or a configured URL; never forward it.
  if (result.error || result.status !== 0) fail(".git", "git-command");
  return result.stdout;
}

function textCandidate(path, size) {
  return size <= MAX_TEXT_BYTES
    && !["package-lock.json", "Cargo.lock"].includes(basename(path))
    && !BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

function workingDocument(root, path, privateMode) {
  const target = resolve(root, path);
  const inside = relative(root, target);
  if (inside.startsWith("..") || isAbsolute(inside)) fail(path, "file-path");
  try {
    const parts = path.split("/");
    // Do not follow a directory symlink into another checkout or local data.
    for (let index = 1; index < parts.length; index++) {
      if (lstatSync(join(root, ...parts.slice(0, index))).isSymbolicLink()) {
        diagnostic(path, 1, "symlink-path");
        return null;
      }
    }
    const stat = lstatSync(target);
    if (!privateMode && !textCandidate(path, stat.size)) return null;
    if (stat.isSymbolicLink()) {
      if (privateMode && CONFIG_PATHS.has(path)) {
        diagnostic(path, 1, "VOXELIGHT_MS_CLIENT_ID");
        return null;
      }
      return { path, buffer: Buffer.from(readlinkSync(target)) };
    }
    if (!stat.isFile()) return null;
    return { path, buffer: readFileSync(target) };
  } catch (error) {
    // A removed working file is still scanned from the index below.
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    fail(path, "file-read");
  }
}

function indexDocuments(root, entries, privateMode) {
  const objects = new Map();
  for (const entry of entries) {
    if (privateMode && CONFIG_PATHS.has(entry.path) && entry.mode === "120000") {
      diagnostic(entry.path, 1, "VOXELIGHT_MS_CLIENT_ID");
      continue;
    }
    if (entry.mode === "160000" || (!privateMode && !textCandidate(entry.path, 0))) continue;
    if (!objects.has(entry.oid)) objects.set(entry.oid, []);
    objects.get(entry.oid).push(entry.path);
  }
  if (objects.size === 0) return [];
  const metadata = git(root, ["cat-file", "--batch-check"], { input: `${[...objects.keys()].join("\n")}\n` }).toString("utf8");
  const selected = metadata.trim().split("\n").map(line => {
    const [oid, type, bytes] = line.trim().split(" ");
    if (type !== "blob" || !/^\d+$/.test(bytes)) fail(".git/index", "git-object");
    return { oid, size: Number(bytes) };
  }).filter(object => privateMode || object.size <= MAX_TEXT_BYTES);
  const documents = [];
  // Bound each batch rather than spawning one Git process for every file.
  for (let offset = 0; offset < selected.length;) {
    const batch = [];
    let size = 0;
    do {
      const object = selected[offset++];
      batch.push(object);
      size += object.size + 128;
    } while (offset < selected.length && size + selected[offset].size < 16 * 1024 * 1024);
    const content = git(root, ["cat-file", "--batch"], {
      input: `${batch.map(object => object.oid).join("\n")}\n`,
      maxBuffer: size + 1024,
    });
    let cursor = 0;
    for (const object of batch) {
      const end = content.indexOf(10, cursor);
      if (end < cursor) fail(".git/index", "git-object");
      const header = content.subarray(cursor, end).toString("ascii");
      if (header !== `${object.oid} blob ${object.size}`) fail(".git/index", "git-object");
      const buffer = content.subarray(end + 1, end + 1 + object.size);
      if (buffer.length !== object.size) fail(".git/index", "git-object");
      for (const path of objects.get(object.oid)) documents.push({ path, buffer });
      cursor = end + object.size + 2;
    }
  }
  return documents;
}

function clientValues(text) {
  return [...text.matchAll(CLIENT_VALUE)].map(match => ({ key: match[1], value: match[2], index: match.index }));
}

function withoutCargoComment(line) {
  let quote = null;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && char === "\\") index++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index).trim();
  }
  return line.trim();
}

function cargoSecret(value, { pattern, ignoreCase }) {
  const direct = new RegExp(`^(["'])(${pattern})\\1$`, ignoreCase ? "i" : "").exec(value.trim());
  if (direct) return direct[2];
  if (!value.startsWith("{") || !value.endsWith("}")) return null;
  const fields = [];
  let quote = null, start = 1;
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index];
    if (quote) {
      if (quote === '"' && char === "\\") index++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if ("{}[]".includes(char)) return null;
    else if (char === ",") { fields.push(value.slice(start, index)); start = index + 1; }
  }
  if (quote) return null;
  fields.push(value.slice(start, -1));
  const assigned = fields.map(field => /^\s*(?:value|"value"|'value')\s*=\s*(.*)$/.exec(field)).filter(Boolean);
  if (assigned.length !== 1) return null;
  const match = new RegExp(`^(["'])(${pattern})\\1$`, ignoreCase ? "i" : "").exec(assigned[0][1].trim());
  return match?.[2] ?? null;
}

/** TOML dotted keys are paths; quoted keys may contain standard Unicode escapes. */
function cargoKeyPath(text) {
  const keys = [];
  let cursor = 0;
  while (cursor < text.length) {
    while (/\s/.test(text[cursor] ?? "")) cursor++;
    if (cursor >= text.length) return null;
    let key = "";
    const quote = text[cursor];
    if (quote === '"' || quote === "'") {
      cursor++;
      let closed = false;
      while (cursor < text.length) {
        const char = text[cursor++];
        if (char === quote) { closed = true; break; }
        if (quote !== '"' || char !== "\\") { key += char; continue; }
        const escaped = text[cursor++];
        if (escaped === "u" || escaped === "U") {
          const length = escaped === "u" ? 4 : 8;
          const hex = text.slice(cursor, cursor + length);
          if (!new RegExp(`^[0-9a-f]{${length}}$`, "i").test(hex)) return null;
          const point = Number.parseInt(hex, 16);
          if (point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) return null;
          key += String.fromCodePoint(point); cursor += length;
        } else {
          const escapes = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
          if (!Object.hasOwn(escapes, escaped)) return null;
          key += escapes[escaped];
        }
      }
      if (!closed) return null;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(cursor));
      if (!bare) return null;
      key = bare[0]; cursor += key.length;
    }
    keys.push(key);
    while (/\s/.test(text[cursor] ?? "")) cursor++;
    if (cursor === text.length) return keys;
    if (text[cursor++] !== ".") return null;
  }
  return null;
}

function cargoAssignment(code) {
  let quote = null;
  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    if (quote) {
      if (quote === '"' && char === "\\") index++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "=") {
      const keys = cargoKeyPath(code.slice(0, index));
      return keys ? { keys, value: code.slice(index + 1).trim() } : null;
    }
  }
  return null;
}

/** Read canonical secret values without silently dropping unknown target paths. */
function privateCargoValues(text, target) {
  const values = [], invalid = [];
  const targetKey = target.key;
  // Windows environment names are case-insensitive. Reject aliases instead of
  // letting a separately parsed canonical ID hide a possible effective value.
  const noncanonicalTarget = keys => keys.some(key => key !== targetKey && key.toUpperCase() === targetKey);
  let section = [], tableLine = 1, tableAssigned = false;
  const targetTable = () => section.length === 2 && section[0] === "env" && section[1] === targetKey;
  const finishTable = () => {
    if (targetTable() && !tableAssigned) invalid.push(tableLine);
  };
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const code = withoutCargoComment(raw), line = index + 1;
    if (!code) continue;
    // Refuse multiline syntax rather than interpreting a key embedded inside
    // another string or accepting noncanonical secret representations.
    if (code.includes('"""') || code.includes("'''")) return { values: [], invalid: [line] };
    if (code.startsWith("[")) {
      finishTable(); tableAssigned = false; tableLine = line;
      const parsed = code.endsWith("]") ? cargoKeyPath(code.slice(1, -1)) : null;
      section = parsed ?? ["<unsupported>"];
      if (noncanonicalTarget(section)) invalid.push(line);
      if (section.includes(targetKey) && !targetTable() || !parsed && code.includes(targetKey)) invalid.push(line);
      continue;
    }
    const assignment = cargoAssignment(code);
    if (!assignment) {
      if (code.includes(targetKey)) invalid.push(line);
      continue;
    }
    const path = [...section, ...assignment.keys];
    if (noncanonicalTarget(path)) { invalid.push(line); continue; }
    // An inline definition of the whole env table is not parsed here; do not
    // let another valid config hide a potentially different ID in that map.
    if (path.length === 1 && path[0] === "env") { invalid.push(line); continue; }
    if (path[0] !== "env" || path[1] !== targetKey) {
      if (path.includes(targetKey)) invalid.push(line);
      continue;
    }
    if (path.length !== 2 && !(path.length === 3 && path[2] === "value")) {
      if (path.length !== 3 || !["force", "relative"].includes(path[2]) || !/^(?:true|false)$/.test(assignment.value)) invalid.push(line);
      continue;
    }
    if (targetTable()) {
      if (tableAssigned) invalid.push(line);
      tableAssigned = true;
    }
    const value = cargoSecret(assignment.value, target);
    if (value) values.push({ value, line });
    else invalid.push(line);
  }
  finishTable();
  return { values, invalid };
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function cargoPath(path) {
  return /^(?:src-tauri\/)?\.cargo(?:\/|$)/i.test(path);
}

function inspectPublicText(path, buffer) {
  if (!textCandidate(path, buffer.length) || buffer.includes(0)) return;
  const text = buffer.toString("utf8");
  for (const match of clientValues(text)) {
    if (!/^([0-9a-f])\1{31}$/i.test(match.value.replaceAll("-", ""))) {
      diagnostic(path, lineAt(text, match.index), match.key);
    }
  }
  for (const match of text.matchAll(CF_VALUE)) {
    // Only a literal repetition qualifies as a synthetic fixture.
    if (!/^([./A-Za-z0-9])\1{52}$/.test(match[1])) {
      diagnostic(path, lineAt(text, match.index), "VOXELIGHT_CF_API_KEY");
    }
  }
}

function outputDirectory(path) {
  return ARCHIVE_OUTPUT_DIRS.some(output => path === output || path.startsWith(`${output}/`));
}

function validArchivePath(path) {
  return typeof path === "string" && path.split("/").every(part =>
    part.length > 0 && !/[. ]$|[\\<>:"|?*\x00-\x1f]/.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
      && part.toLowerCase() !== ".git",
  );
}

function archiveObject(root, path, key) {
  const target = join(root, path);
  const stat = lstatSync(target, { throwIfNoEntry: false });
  if (!stat) fail(path, key);
  if (stat.isSymbolicLink()) fail(path, "symlink-path");
  return { target, stat };
}

// Validate only the extracted tree. SHA-256 establishes consistency with its
// manifest; it does not authenticate the origin of the archive.
async function inspectArchive(root) {
  const rootStat = lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) fail(".", "archive-root");
  for (let dir = root;; dir = dirname(dir)) {
    if (lstatSync(join(dir, ".git"), { throwIfNoEntry: false })) fail(".git", "archive-git");
    if (dirname(dir) === dir) break;
  }
  const { target: manifestFile, stat: manifestStat } = archiveObject(root, ARCHIVE_MANIFEST, "archive-manifest");
  if (!manifestStat.isFile() || manifestStat.size > MAX_TEXT_BYTES) fail(ARCHIVE_MANIFEST, "archive-manifest");
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, "utf8")); }
  catch { fail(ARCHIVE_MANIFEST, "archive-manifest"); }
  if (manifest?.project !== "Voxelight Launcher" || manifest.license !== "GPL-3.0-only"
    || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || !Array.isArray(manifest.files)) fail(ARCHIVE_MANIFEST, "archive-manifest");

  const entries = new Map();
  const portableNames = new Set();
  for (const entry of manifest.files) {
    const path = entry?.path;
    if (!validArchivePath(path) || outputDirectory(path) || path === ARCHIVE_OUTPUT_FILE
      || path.toLowerCase() === ARCHIVE_MANIFEST.toLowerCase()
      || portableNames.has(path.toLowerCase()) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) fail(ARCHIVE_MANIFEST, "archive-entry");
    portableNames.add(path.toLowerCase());
    if (cargoPath(path)) fail(path, "cargo-path");
    entries.set(path, entry);
  }
  for (const required of ARCHIVE_REQUIRED) {
    if (!entries.has(required)) diagnostic(required, 1, "archive-required");
  }

  const seen = new Set();
  const directories = [{ target: root, path: "" }];
  while (directories.length > 0) {
    const directory = directories.pop();
    for (const name of readdirSync(directory.target)) {
      const path = directory.path ? `${directory.path}/${name}` : name;
      if (path === ARCHIVE_MANIFEST) continue;
      if (cargoPath(path)) { diagnostic(path, 1, "cargo-path"); continue; }
      if (!validArchivePath(path)) { diagnostic(path, 1, "archive-path"); continue; }
      const { target, stat } = archiveObject(root, path, "archive-missing");
      if (outputDirectory(path) && stat.isDirectory() || path === ARCHIVE_OUTPUT_FILE && stat.isFile()) continue;
      if (stat.isDirectory()) { directories.push({ path, target }); continue; }
      if (!stat.isFile() || !entries.has(path)) { diagnostic(path, 1, "archive-unlisted"); continue; }

      const { bytes, sha256 } = entries.get(path);
      seen.add(path);
      if (stat.size !== bytes) { diagnostic(path, 1, "archive-hash"); continue; }
      const hash = createHash("sha256");
      let buffer;
      if (textCandidate(path, bytes)) {
        buffer = readFileSync(target);
        hash.update(buffer);
      } else {
        for await (const chunk of createReadStream(target)) hash.update(chunk);
      }
      if (hash.digest("hex") !== sha256) { diagnostic(path, 1, "archive-hash"); continue; }
      if (path === "package.json") {
        let metadata;
        try { metadata = JSON.parse(buffer?.toString("utf8")); }
        catch { fail(path, "archive-package"); }
        if (metadata?.name !== "voxelight-launcher" || metadata.version !== manifest.version || metadata.license !== manifest.license)
          fail(path, "archive-package");
      }
      if (buffer) inspectPublicText(path, buffer);
    }
  }
  for (const path of entries.keys()) {
    if (!seen.has(path)) diagnostic(path, 1, "archive-missing");
  }
}

function inspect(root) {
  if (git(root, ["rev-parse", "--show-prefix"]).toString("utf8").trim()) fail(".", "repository-root");
  const privateValue = git(root, ["config", "--local", "--bool", "--get", "voxelight.private"], { missing: true });
  const privateMode = privateValue?.toString("utf8").trim() === "true";
  const paths = new Set(git(root, ["ls-files", "-co", "--exclude-standard", "-z"]).toString("utf8").split("\0").filter(Boolean));
  const entries = git(root, ["ls-files", "--stage", "-z"]).toString("utf8").split("\0").filter(Boolean).map(line => {
    const tab = line.indexOf("\t");
    const [mode, oid] = line.slice(0, tab).split(" ");
    return { path: line.slice(tab + 1), mode, oid };
  });

  if (privateMode) {
    // Local config is normally ignored, so explicitly include both locations.
    for (const path of CONFIG_PATHS) paths.add(path);
    const remotes = git(root, ["remote"]).toString("utf8").trim().split(/\r?\n/).filter(Boolean);
    for (const remote of remotes) {
      const urls = git(root, ["remote", "get-url", "--push", "--all", remote]).toString("utf8").trim().split(/\r?\n/);
      if (urls.some(url => !DISABLED_PUSH_URLS.has(url))) diagnostic(".git/config", 1, "remote.pushurl");
    }
  } else {
    for (const path of [...paths, ...entries.map(entry => entry.path)]) {
      if (cargoPath(path)) diagnostic(path, 1, "cargo-path");
    }
    // Full history and merge diffs catch removed configs, side refs, and configs
    // first introduced (or discarded) by a merge resolution.
    const history = git(root, ["log", "--all", "--full-history", "--root", "--no-renames", "-m", "--format=", "--name-only", "-z", "--", ":(top,icase).cargo", ":(top,icase)src-tauri/.cargo"]);
    for (const path of history.toString("utf8").split("\0")) {
      const name = path.replace(/^\n+/, "");
      if (cargoPath(name)) diagnostic(name, 1, "cargo-history");
    }
  }

  const documents = [...paths].map(path => workingDocument(root, path, privateMode)).filter(Boolean);
  const workingConfigs = documents.filter(document => CONFIG_PATHS.has(document.path));
  documents.push(...indexDocuments(root, entries, privateMode));
  const privateValues = new Map();
  if (privateMode) {
    const configs = documents.filter(document => CONFIG_PATHS.has(document.path));
    for (const target of PRIVATE_TARGETS) {
      let workingValueFound = false;
      const exact = new Set();
      for (const document of configs) {
        const parsed = privateCargoValues(document.buffer.toString("utf8"), target);
        for (const line of parsed.invalid) diagnostic(document.path, line, target.key);
        for (const { value } of parsed.values) exact.add(target.ignoreCase ? value.toLowerCase() : value);
        if (workingConfigs.includes(document) && parsed.values.length > 0) workingValueFound = true;
      }
      if (target.required && (!workingValueFound || exact.size === 0)) {
        diagnostic(workingConfigs[0]?.path ?? "src-tauri/.cargo/config.toml", 1, target.key);
      }
      if (exact.size > 0) privateValues.set(target, exact);
    }
  }
  for (const { path, buffer } of documents) {
    if (privateMode && CONFIG_PATHS.has(path)) continue;
    if (privateValues.size > 0) {
      const text = buffer.toString("utf8");
      for (const [target, exact] of privateValues) {
        const haystack = target.ignoreCase ? text.toLowerCase() : text;
        for (const value of exact) {
          const index = haystack.indexOf(value);
          if (index >= 0) diagnostic(path, lineAt(text, index), target.key);
        }
      }
    }
    inspectPublicText(path, buffer);
  }
  return privateMode;
}

let mode = "public";
try {
  const args = process.argv.slice(2);
  const archiveMode = args[0] === "--archive";
  if (archiveMode) args.shift();
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--root" || !args[1])) fail(".", "arguments");
  const root = args.length ? resolve(args[1]) : fileURLToPath(new URL("..", import.meta.url));
  if (archiveMode) {
    mode = "archive";
    await inspectArchive(root);
  } else if (inspect(root)) {
    mode = "private";
  }
} catch {
  if (diagnostics.size === 0) diagnostic(".", 1, "guard-error");
}
if (diagnostics.size > 0) {
  for (const entry of [...diagnostics].sort()) console.error(entry);
  process.exitCode = 1;
} else {
  console.log(`Public secrets guard passed (${mode} mode).`);
}
