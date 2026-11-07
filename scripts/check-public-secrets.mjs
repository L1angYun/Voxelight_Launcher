import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const CONFIG_PATHS = new Set([".cargo/config.toml", "src-tauri/.cargo/config.toml"]);
const DISABLED_PUSH_URLS = new Set(["DISABLED", "DISABLED-private-never-pushes"]);
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".zip", ".jar", ".exe", ".dll", ".pdf", ".mp4", ".webm"]);
const UUID_SOURCE = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
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
    if (stat.isSymbolicLink()) return { path, buffer: Buffer.from(readlinkSync(target)) };
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

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function cargoPath(path) {
  return /^(?:src-tauri\/)?\.cargo(?:\/|$)/i.test(path);
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
  documents.push(...indexDocuments(root, entries, privateMode));
  const privateIds = new Set();
  if (privateMode) {
    for (const document of documents.filter(document => CONFIG_PATHS.has(document.path))) {
      for (const match of clientValues(document.buffer.toString("utf8"))) {
        if (match.key === "VOXELIGHT_MS_CLIENT_ID") privateIds.add(match.value.toLowerCase());
      }
    }
  }
  for (const { path, buffer } of documents) {
    if (privateMode && CONFIG_PATHS.has(path)) continue;
    const text = buffer.toString("utf8");
    if (privateIds.size > 0) {
      const lower = text.toLowerCase();
      for (const id of privateIds) {
        const index = lower.indexOf(id);
        if (index >= 0) diagnostic(path, lineAt(text, index), "VOXELIGHT_MS_CLIENT_ID");
      }
    }
    if (!textCandidate(path, buffer.length) || buffer.includes(0)) continue;
    for (const match of clientValues(text)) {
      if (!/^([0-9a-f])\1{31}$/i.test(match.value.replaceAll("-", ""))) {
        diagnostic(path, lineAt(text, match.index), match.key);
      }
    }
  }
  return privateMode;
}

let privateMode = false;
try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--root" || !args[1])) fail(".", "arguments");
  const root = args.length ? resolve(args[1]) : fileURLToPath(new URL("..", import.meta.url));
  privateMode = inspect(root);
} catch {
  if (diagnostics.size === 0) diagnostic(".", 1, "guard-error");
}
if (diagnostics.size > 0) {
  for (const entry of [...diagnostics].sort()) console.error(entry);
  process.exitCode = 1;
} else {
  console.log(`Public secrets guard passed (${privateMode ? "private" : "public"} mode).`);
}
