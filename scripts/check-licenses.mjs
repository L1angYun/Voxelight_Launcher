// SPDX-License-Identifier: GPL-3.0-only
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "licenses");
const write = process.argv.includes("--write");
const permitted = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "bzip2-1.0.6",
  "CC0-1.0",
  "CDLA-Permissive-2.0",
  "CPL-1.0",
  "GPL-3.0-only",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
]);
const notices = /^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/i;
const inventory = [];
const failures = [];
const inventoryPath = path.join(output, "dependency-inventory.json");
let savedPackages = [];
if (!write && existsSync(inventoryPath)) {
  try {
    const saved = JSON.parse(readFileSync(inventoryPath, "utf8"));
    savedPackages = Array.isArray(saved.packages) ? saved.packages : [];
  } catch (error) {
    failures.push(`Cannot read saved dependency inventory: ${error.message}`);
  }
}

function licenseAllowed(expression) {
  if (!expression) return false;
  return expression.split(/\s+OR\s+/i).some((alternative) => {
    const normalized = alternative
      .replace(/[()]/g, " ")
      .replaceAll("/", " OR ");
    if (/\bOR\b/.test(normalized)) return licenseAllowed(normalized);
    if (/\bLGPL\b/i.test(normalized)) return false;
    return normalized.split(/\s+AND\s+/i).every((part) => {
      const term = part.trim().replace(/\s+WITH\s+LLVM-exception/i, "");
      return permitted.has(term);
    });
  });
}

function record(packageInfo, files, origin, noticeType = "package-notice") {
  const entry = {
    name: packageInfo.name,
    version: packageInfo.version,
    license: packageInfo.license,
    source: origin,
    noticeType,
    notices: [...files].sort(),
  };
  inventory.push(entry);
  if (!licenseAllowed(packageInfo.license)) {
    failures.push(
      `${entry.name}@${entry.version}: review license ${entry.license || "missing"}`,
    );
  }
  if (!files.length)
    failures.push(`${entry.name}@${entry.version}: missing license notice`);
}

function recordSaved(name, version, declaredLicense) {
  const candidates = savedPackages.filter(
    (item) =>
      item.name === name && item.version === version && item.notices?.length,
  );
  const saved =
    candidates.find((item) => item.noticeType !== "package-notice") ||
    candidates[0];
  if (!saved || (declaredLicense && saved.license !== declaredLicense))
    return false;
  record(
    { name, version, license: saved.license },
    saved.notices,
    saved.source,
    saved.noticeType,
  );
  return true;
}

function destination(kind, name, version) {
  return path.join(
    output,
    kind,
    `${name.replace(/^@/, "").replaceAll("/", "--")}@${version}`,
  );
}

function copyNotices(kind, name, version, directory, origin) {
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && notices.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const target = destination(kind, name, version);
  const copied = [];
  for (const filename of files) {
    const source = path.join(directory, filename);
    if (statSync(source).size > 1024 * 1024) {
      failures.push(`${name}@${version}: notice too large: ${filename}`);
      continue;
    }
    if (write) {
      mkdirSync(target, { recursive: true });
      copyFileSync(source, path.join(target, filename));
    }
    copied.push(
      path.relative(root, path.join(target, filename)).replaceAll("\\", "/"),
    );
  }
  return copied;
}

function saveEvidence(kind, name, version, filename, contents) {
  const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (data.length > 1024 * 1024)
    throw new Error(`${name}@${version}: evidence is too large: ${filename}`);
  const base = path.resolve(destination(kind, name, version));
  const target = path.resolve(base, filename);
  if (!target.startsWith(`${base}${path.sep}`))
    throw new Error(`${name}@${version}: invalid evidence path: ${filename}`);
  if (write) {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return path.relative(root, target).replaceAll("\\", "/");
}

function licenseExpression(manifest) {
  const license = manifest?.license;
  return typeof license === "string" ? license : license?.type;
}

function licenseAlternatives(expression) {
  if (!expression) return [];
  return expression
    .replace(/[()]/g, " ")
    .replaceAll("/", " OR ")
    .split(/\s+OR\s+/i)
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

function licensesCompatible(left, right) {
  const a = licenseAlternatives(left);
  const b = licenseAlternatives(right);
  if (!a.length || !b.length) return false;
  if (a.length === b.length && a.every((term) => b.includes(term))) return true;
  const dual = new Set(["MIT", "Apache-2.0"]);
  return (
    a.every((term) => dual.has(term)) &&
    b.every((term) => dual.has(term)) &&
    a.some((term) => b.includes(term))
  );
}

function gitHubRepository(repository) {
  let value =
    typeof repository === "string" ? repository : repository?.url || "";
  value = value
    .replace(/^git\+/, "")
    .replace(/^git:\/\/github\.com\//, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");
  const match = value.match(
    /^https:\/\/github\.com\/([\w-]+\/[\w.-]+?)(?:\.git)?\/?$/,
  );
  return match?.[1] || null;
}

function repositoryDirectory(repository) {
  const directory = repository?.directory || "";
  if (!directory) return "";
  if (
    !/^[A-Za-z0-9._/-]+$/.test(directory) ||
    directory.split("/").includes("..")
  )
    throw new Error(`Invalid repository.directory: ${directory}`);
  return directory.replace(/^\/+|\/+$/g, "");
}

async function retrieve(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        headers: { "User-Agent": "VoxelightLauncher/0.5.0" },
      });
    } catch (error) {
      lastError = error;
    }
    if (response) {
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      return response;
    }
    if (attempt < 2)
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw lastError;
}

const registryManifests = new Map();

function npmRegistryManifest(name, version, info) {
  const key = `${name}@${version}`;
  if (!registryManifests.has(key)) {
    registryManifests.set(
      key,
      (async () => {
        const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`;
        const raw = Buffer.from(await (await retrieve(url)).arrayBuffer());
        if (raw.length > 1024 * 1024)
          throw new Error(`${key}: registry manifest is too large`);
        const manifest = JSON.parse(raw.toString("utf8"));
        if (manifest.name !== name || manifest.version !== version)
          throw new Error(`${key}: registry name or version mismatch`);
        if (info.integrity && manifest.dist?.integrity !== info.integrity)
          throw new Error(`${key}: registry dist.integrity mismatch`);
        if (info.resolved && manifest.dist?.tarball !== info.resolved)
          throw new Error(`${key}: registry tarball URL mismatch`);
        if (info.license && licenseExpression(manifest) !== info.license)
          throw new Error(`${key}: registry license declaration mismatch`);
        return { manifest, raw, url };
      })(),
    );
  }
  return registryManifests.get(key);
}

const spdxTexts = new Map();

function spdxText(identifier) {
  if (!spdxTexts.has(identifier)) {
    spdxTexts.set(
      identifier,
      (async () => {
        const url = `https://spdx.org/licenses/${identifier}.json`;
        const data = await (await retrieve(url)).json();
        if (
          data.licenseId !== identifier ||
          typeof data.licenseText !== "string" ||
          !data.licenseText.trim()
        )
          throw new Error(`Invalid SPDX license text response: ${identifier}`);
        return { text: data.licenseText, url };
      })(),
    );
  }
  return spdxTexts.get(identifier);
}

function spdxIdentifiers(expression) {
  return [
    ...new Set(
      (expression?.match(/[A-Za-z0-9][A-Za-z0-9.+:-]*/g) || []).filter(
        (token) => !["AND", "OR", "WITH", "LLVM-exception"].includes(token),
      ),
    ),
  ];
}

async function canonicalNotices(kind, packageInfo, evidence) {
  if (!packageInfo.license)
    throw new Error(
      `${packageInfo.name}@${packageInfo.version}: no declared license`,
    );
  if (!evidence.contents?.length)
    throw new Error(
      `${packageInfo.name}@${packageInfo.version}: no upstream package manifest`,
    );
  const identifiers = spdxIdentifiers(packageInfo.license);
  if (!identifiers.length)
    throw new Error(
      `${packageInfo.name}@${packageInfo.version}: no SPDX license identifier`,
    );
  const texts = [];
  for (const identifier of identifiers)
    texts.push({ identifier, ...(await spdxText(identifier)) });
  const files = [
    saveEvidence(
      kind,
      packageInfo.name,
      packageInfo.version,
      evidence.filename,
      evidence.contents,
    ),
  ];
  for (const item of texts)
    files.push(
      saveEvidence(
        kind,
        packageInfo.name,
        packageInfo.version,
        `SPDX-${item.identifier}.txt`,
        item.text,
      ),
    );
  record(
    packageInfo,
    files,
    `${evidence.description}; verified SPDX licenseText: ${texts.map((item) => item.url).join(", ")}`,
    "upstream-declaration-and-spdx-license-text",
  );
}

function tarNotices(archive) {
  const entries = execFileSync("tar", ["-tf", archive], {
    encoding: "utf8",
  }).split(/\r?\n/);
  const files = new Map();
  for (const entry of entries) {
    const relative = entry.startsWith("package/") ? entry.slice(8) : "";
    if (relative && !relative.includes("/") && notices.test(relative)) {
      const contents = execFileSync(
        "tar",
        ["-xOf", archive, entry],
        {
          maxBuffer: 1024 * 1024,
        },
      );
      files.set(relative, contents);
    }
  }
  let license;
  let manifestRaw;
  if (entries.includes("package/package.json")) {
    manifestRaw = execFileSync(
      "tar",
      ["-xOf", archive, "package/package.json"],
      {
        maxBuffer: 1024 * 1024,
      },
    );
    license = licenseExpression(JSON.parse(manifestRaw.toString("utf8")));
  }
  return { files, license, manifestRaw };
}

async function npmOptionalParent(name, version, info, declaredLicense) {
  const candidates = packages.filter(
    (parent) =>
      parent.version === version &&
      parent.optionalDependencies?.[name] === version,
  );
  if (!candidates.length) return false;
  const childRegistry = await npmRegistryManifest(name, version, info);
  for (const parent of candidates) {
    if (!parent.integrity || !parent.resolved)
      throw new Error(
        `${parent.name}@${parent.version}: parent lacks registry integrity evidence`,
      );
    const directory = path.join(root, parent.lockPath);
    const manifestPath = path.join(directory, "package.json");
    if (!existsSync(manifestPath))
      throw new Error(
        `${parent.name}@${parent.version}: parent package manifest is unavailable`,
      );
    const localManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (localManifest.name !== parent.name || localManifest.version !== version)
      throw new Error(
        `${parent.name}@${parent.version}: local parent identity mismatch`,
      );
    const parentLicense =
      licenseExpression(localManifest) || licenseExpression(parent);
    if (
      !licensesCompatible(declaredLicense, parentLicense) ||
      !licensesCompatible(declaredLicense, info.license)
    )
      throw new Error(
        `${name}@${version}: optional parent license declaration mismatch`,
      );
    const [parentRegistry] = await Promise.all([
      npmRegistryManifest(parent.name, parent.version, parent),
    ]);
    const childRepository = gitHubRepository(childRegistry.manifest.repository);
    const parentRepository = gitHubRepository(
      parentRegistry.manifest.repository,
    );
    if (
      !childRepository ||
      childRepository !== parentRepository ||
      !licensesCompatible(
        licenseExpression(childRegistry.manifest),
        licenseExpression(parentRegistry.manifest),
      )
    )
      throw new Error(
        `${name}@${version}: optional parent registry family verification failed`,
      );
    const files = copyNotices(
      "npm",
      name,
      version,
      directory,
      `npm:${parent.name}@${parent.version}`,
    );
    if (!files.length)
      throw new Error(
        `${parent.name}@${parent.version}: optional parent has no local notices`,
      );
    record(
      { name, version, license: declaredLicense },
      files,
      `npm:${parent.name}@${parent.version} (${parent.lockPath}) local notices; lockfile optionalDependencies[${name}]=${version}; registry name/version/dist.integrity/repository/license verified for parent and child`,
      "optional-parent-notice",
    );
    return true;
  }
  return false;
}

function npmTagCommit(project, name, version) {
  const unscoped = name.split("/").at(-1);
  const tags = [
    ...new Set([
      `v${version}`,
      version,
      `${name}@${version}`,
      `${unscoped}@${version}`,
      `${unscoped}-v${version}`,
    ]),
  ];
  const output = execFileSync(
    "git",
    [
      "ls-remote",
      "--tags",
      `https://github.com/${project}.git`,
      ...tags.flatMap((tag) => [`refs/tags/${tag}`, `refs/tags/${tag}^{}`]),
    ],
    {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  const refs = new Map(
    output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, ref] = line.split(/\s+/);
        return [ref, hash];
      }),
  );
  for (const tag of tags) {
    const commit =
      refs.get(`refs/tags/${tag}^{}`) || refs.get(`refs/tags/${tag}`);
    if (/^[a-f0-9]{40}$/.test(commit || "")) return { commit, tag };
  }
  return null;
}

async function rawPinnedNotices(
  kind,
  name,
  version,
  project,
  commit,
  directory,
) {
  const files = [];
  for (const base of [...new Set(["", directory])]) {
    for (const filename of [
      "LICENSE",
      "LICENSE.txt",
      "LICENSE.md",
      "LICENCE",
      "LICENCE.txt",
      "COPYING",
      "COPYING.txt",
      "NOTICE",
      "NOTICE.txt",
      "COPYRIGHT",
      "COPYRIGHT.txt",
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "LICENSE_APACHE-2.0",
      "LICENSE_MIT",
    ]) {
      const relative = base ? `${base}/${filename}` : filename;
      const url = `https://raw.githubusercontent.com/${project}/${commit}/${relative
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      let response;
      try {
        response = await retrieve(url);
      } catch (error) {
        if (error.message.startsWith("HTTP 404:")) continue;
        throw error;
      }
      const contents = Buffer.from(await response.arrayBuffer());
      files.push(saveEvidence(kind, name, version, relative, contents));
    }
  }
  return files;
}

async function npmPinnedNotices(name, version, info, declaredLicense) {
  const registry = await npmRegistryManifest(name, version, info);
  const project = gitHubRepository(registry.manifest.repository);
  if (!project) return false;
  const tagged = /^[a-f0-9]{40}$/.test(registry.manifest.gitHead || "")
    ? null
    : npmTagCommit(project, name, version);
  const commit = tagged?.commit || registry.manifest.gitHead;
  if (!/^[a-f0-9]{40}$/.test(commit || "")) return false;
  const directory = repositoryDirectory(registry.manifest.repository);
  const treeUrl = `https://api.github.com/repos/${project}/git/trees/${commit}?recursive=1`;
  let copied = [];
  try {
    const tree = await (await retrieve(treeUrl)).json();
    if (tree.truncated)
      throw new Error(`${name}@${version}: upstream tree was truncated`);
    const candidates = tree.tree.filter((entry) => {
      if (
        entry.type !== "blob" ||
        entry.size > 1024 * 1024 ||
        !/^[A-Za-z0-9._/-]+$/.test(entry.path)
      )
        return false;
      const parts = entry.path.split("/");
      if (parts.includes("..") || !notices.test(parts.at(-1))) return false;
      return (
        parts.length === 1 ||
        (directory &&
          entry.path.startsWith(`${directory}/`) &&
          parts.length === directory.split("/").length + 1)
      );
    });
    copied = await Promise.all(
      candidates.map(async (entry) => {
        const url = `https://raw.githubusercontent.com/${project}/${commit}/${entry.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`;
        const contents = Buffer.from(await (await retrieve(url)).arrayBuffer());
        return saveEvidence("npm", name, version, entry.path, contents);
      }),
    );
  } catch (error) {
    if (!error.message.startsWith("HTTP 403:")) throw error;
    copied = await rawPinnedNotices(
      "npm",
      name,
      version,
      project,
      commit,
      directory,
    );
  }
  if (!copied.length) return false;
  record(
    {
      name,
      version,
      license: declaredLicense || licenseExpression(registry.manifest),
    },
    copied,
    `https://github.com/${project}/tree/${commit} (${tagged ? `exact tag ${tagged.tag} verified by git ls-remote` : "registry gitHead"})`,
    "pinned-upstream-notice",
  );
  return true;
}

async function npmRegistryEvidence(name, version, info) {
  if (
    info.resolved?.startsWith("https://registry.npmjs.org/") &&
    info.integrity?.startsWith("sha512-")
  )
    return info;
  if (info.resolved || info.integrity || !info.optional) return null;
  const registry = await npmRegistryManifest(name, version, info);
  const resolved = registry.manifest.dist?.tarball;
  const integrity = registry.manifest.dist?.integrity;
  if (
    !resolved?.startsWith("https://registry.npmjs.org/") ||
    !integrity?.startsWith("sha512-")
  )
    throw new Error(`${name}@${version}: registry dist evidence is incomplete`);
  return { ...info, resolved, integrity };
}

async function npmPackage(name, version, info) {
  const directory = path.join(
    root,
    info.lockPath || path.join("node_modules", name),
  );
  const files = copyNotices(
    "npm",
    name,
    version,
    directory,
    `npm:${name}@${version}`,
  );
  const localManifest = path.join(directory, "package.json");
  const local = existsSync(localManifest)
    ? JSON.parse(readFileSync(localManifest, "utf8"))
    : undefined;
  const declaredLicense = info.license || licenseExpression(local);
  if (files.length && declaredLicense) {
    record(
      { name, version, license: declaredLicense },
      files,
      `npm:${name}@${version}`,
    );
    return;
  }
  if (!write) {
    if (recordSaved(name, version, declaredLicense)) return;
    record(
      { name, version, license: declaredLicense },
      files,
      "offline check has no saved verified fallback; rerun with --write",
      "missing-notice",
    );
    return;
  }
  const registryInfo = await npmRegistryEvidence(name, version, info);
  if (!registryInfo) {
    record({ name, version, license: declaredLicense }, files, "npm lockfile");
    return;
  }
  if (await npmOptionalParent(name, version, registryInfo, declaredLicense))
    return;
  if (await npmPinnedNotices(name, version, registryInfo, declaredLicense))
    return;
  const response = await retrieve(registryInfo.resolved);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (
    `sha512-${createHash("sha512").update(buffer).digest("base64")}` !==
    registryInfo.integrity
  ) {
    throw new Error(`Integrity mismatch in ${name}@${version}`);
  }
  const temporary = mkdtempSync(path.join(root, ".license-tmp-"));
  try {
    const archive = path.join(temporary, "package.tgz");
    writeFileSync(archive, buffer);
    const archived = tarNotices(archive);
    const copied = [...files];
    if (!files.length)
      for (const [filename, contents] of archived.files)
        copied.push(saveEvidence("npm", name, version, filename, contents));
    const license = declaredLicense || archived.license;
    if (copied.length) {
      record(
        { name, version, license },
        copied,
        `${registryInfo.resolved} (integrity verified)`,
        "registry-tar-notice",
      );
      return;
    }
    if (archived.manifestRaw && license) {
      await canonicalNotices(
        "npm",
        { name, version, license },
        {
          filename: "package.json",
          contents: archived.manifestRaw,
          description: `${registryInfo.resolved} (integrity verified package/package.json; no standalone package notice)`,
        },
      );
      return;
    }
    record(
      { name, version, license },
      copied,
      `${registryInfo.resolved} (integrity verified)`,
      "registry-tar-notice",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function cargoWinapiParent(item) {
  if (
    !["winapi-i686-pc-windows-gnu", "winapi-x86_64-pc-windows-gnu"].includes(
      item.name,
    )
  )
    return false;
  const parent = cargoPackages.find(
    (candidate) => candidate.name === "winapi" && candidate.version === "0.3.9",
  );
  const resolved = parent && cargoResolve.get(parent.id);
  if (
    !parent ||
    !resolved?.deps.some((dependency) => dependency.pkg === item.id) ||
    !licensesCompatible(item.license, parent.license) ||
    gitHubRepository(item.repository) !== gitHubRepository(parent.repository)
  )
    return false;
  const files = copyNotices(
    "cargo",
    item.name,
    item.version,
    path.dirname(parent.manifest_path),
    `cargo:${parent.name}@${parent.version}`,
  );
  if (!files.length)
    throw new Error(`${parent.name}@${parent.version}: no reusable notices`);
  record(
    item,
    files,
    `cargo:${parent.name}@${parent.version} local notices; exact Cargo resolve dependency on ${item.name}@${item.version}; repository and license declarations verified`,
    "resolved-parent-notice",
  );
  return true;
}

async function cargoCanonical(item, directory, reason) {
  const original = path.join(directory, "Cargo.toml.orig");
  const manifest = existsSync(original)
    ? original
    : path.join(directory, "Cargo.toml");
  await canonicalNotices("cargo", item, {
    filename: path.basename(manifest),
    contents: readFileSync(manifest),
    description: `${item.source || "local"} ${path.basename(manifest)} (${reason})`,
  });
}

async function cargoPackage(item) {
  const directory = path.dirname(item.manifest_path);
  const local = copyNotices(
    "cargo",
    item.name,
    item.version,
    directory,
    item.source || "local",
  );
  if (local.length) {
    record(item, local, item.source || "local");
    return;
  }
  if (!write) {
    if (recordSaved(item.name, item.version, item.license)) return;
    record(
      item,
      [],
      "offline check has no saved verified fallback; rerun with --write",
      "missing-notice",
    );
    return;
  }
  if (cargoWinapiParent(item)) return;
  const project = gitHubRepository(item.repository);
  const vcsPath = path.join(directory, ".cargo_vcs_info.json");
  if (!project || !existsSync(vcsPath)) {
    await cargoCanonical(
      item,
      directory,
      "crate has no verifiable repository/commit and no standalone package notice",
    );
    return;
  }
  const vcs = JSON.parse(readFileSync(vcsPath, "utf8"));
  const commit = vcs.git?.sha1;
  if (!/^[a-f0-9]{40}$/.test(commit || "")) {
    await cargoCanonical(
      item,
      directory,
      "crate has no pinned source commit or standalone package notice",
    );
    return;
  }
  const treeUrl = `https://api.github.com/repos/${project}/git/trees/${commit}?recursive=1`;
  const crate = vcs.path_in_vcs || "";
  let tree;
  try {
    tree = await (await retrieve(treeUrl)).json();
  } catch (error) {
    if (!error.message.startsWith("HTTP 403:")) throw error;
    if (["r-efi", "selectors"].includes(item.name)) {
      await cargoCanonical(
        item,
        directory,
        "no standalone package notice; tree API returned HTTP 403; using the actual crate declaration instead of assuming repository LICENSE files",
      );
      return;
    }
    const copied = await rawPinnedNotices(
      "cargo",
      item.name,
      item.version,
      project,
      commit,
      crate,
    );
    if (!copied.length) throw error;
    record(
      item,
      copied,
      `https://github.com/${project}/tree/${commit} (Cargo source commit; pinned raw paths after tree API HTTP 403)`,
      "pinned-upstream-notice",
    );
    return;
  }
  if (tree.truncated)
    throw new Error(
      `${item.name}@${item.version}: upstream tree was truncated`,
    );
  const candidates = tree.tree.filter((entry) => {
    if (
      entry.type !== "blob" ||
      entry.size > 1024 * 1024 ||
      !/^[A-Za-z0-9._/-]+$/.test(entry.path)
    )
      return false;
    const parts = entry.path.split("/");
    if (parts.includes("..") || !notices.test(parts.at(-1))) return false;
    return (
      parts.length === 1 ||
      (crate &&
        entry.path.startsWith(`${crate}/`) &&
        parts.length === crate.split("/").length + 1)
    );
  });
  if (!candidates.length) {
    await cargoCanonical(
      item,
      directory,
      `no root or crate license at pinned upstream tree ${treeUrl}`,
    );
    return;
  }
  const copied = await Promise.all(
    candidates.map(async (entry) => {
      const url = `https://raw.githubusercontent.com/${project}/${commit}/${entry.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      const contents = Buffer.from(await (await retrieve(url)).arrayBuffer());
      return saveEvidence(
        "cargo",
        item.name,
        item.version,
        entry.path,
        contents,
      );
    }),
  );
  record(
    item,
    copied,
    `https://github.com/${project}/tree/${commit} (Cargo source commit)`,
    "pinned-upstream-notice",
  );
}

async function collectToolchain() {
  const local = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "tauri", "NSIS")
    : "";
  const installed = local && existsSync(path.join(local, "COPYING"));
  if (write && !installed)
    throw new Error(
      "NSIS toolchain is missing; run the standard Tauri build first",
    );
  const directory = installed
    ? local
    : destination("toolchain", "nsis", "3.13");
  const files = copyNotices(
    "toolchain",
    "nsis",
    "3.13",
    directory,
    "NSIS toolchain",
  );
  record(
    {
      name: "nsis",
      version: "3.13",
      license: "Zlib AND bzip2-1.0.6 AND CPL-1.0",
    },
    files,
    "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip",
  );
  const name = "nsis-tauri-utils";
  const version = "0.5.3";
  const target = destination("toolchain", name, version);
  const copied = [];
  for (const filename of ["LICENSE_APACHE-2.0", "LICENSE_MIT"]) {
    const source = `https://raw.githubusercontent.com/tauri-apps/nsis-tauri-utils/nsis_tauri_utils-v${version}/${filename}`;
    if (write) {
      const contents = Buffer.from(
        await (await retrieve(source)).arrayBuffer(),
      );
      if (contents.length > 1024 * 1024)
        throw new Error("NSIS plugin notice is too large");
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, filename), contents);
    }
    copied.push(
      path.relative(root, path.join(target, filename)).replaceAll("\\", "/"),
    );
  }
  record(
    { name, version, license: "Apache-2.0 OR MIT" },
    copied,
    `https://github.com/tauri-apps/nsis-tauri-utils/tree/nsis_tauri_utils-v${version}`,
  );
}

if (write) {
  mkdirSync(output, { recursive: true });
  for (const kind of ["npm", "cargo", "toolchain"]) {
    rmSync(path.join(output, kind), { recursive: true, force: true });
  }
}
const cargo = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      path.join(root, "src-tauri/Cargo.toml"),
      "--locked",
      ...(write ? [] : ["--offline"]),
      "--format-version",
      "1",
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  ),
);
const cargoResolve = new Map(
  (cargo.resolve?.nodes || []).map((node) => [node.id, node]),
);
const manifest = path.join(root, "src-tauri", "Cargo.toml");
const cargoPackages = cargo.packages
  .filter((item) => item.manifest_path !== manifest)
  .sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
for (let index = 0; index < cargoPackages.length; index += 6) {
  const batch = cargoPackages.slice(index, index + 6);
  console.log(
    `Checking Cargo notices ${index + 1}–${index + batch.length}/${cargoPackages.length}`,
  );
  await Promise.all(
    batch.map((item) =>
      cargoPackage(item).catch((error) => {
        failures.push(`${item.name}@${item.version}: ${error.message}`);
      }),
    ),
  );
}
const lock = JSON.parse(
  readFileSync(path.join(root, "package-lock.json"), "utf8"),
);
const packages = Object.entries(lock.packages)
  .filter(([directory]) => directory)
  .map(([directory, info]) => ({
    ...info,
    name: info.name || directory.split("node_modules/").at(-1),
    version: info.version,
    lockPath: directory,
  }))
  .sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
for (let index = 0; index < packages.length; index += 8) {
  await Promise.all(
    packages.slice(index, index + 8).map((item) =>
      npmPackage(item.name, item.version, item).catch((error) => {
        failures.push(`${item.name}@${item.version}: ${error.message}`);
      }),
    ),
  );
}
try {
  await collectToolchain();
} catch (error) {
  failures.push(`Installer toolchain: ${error.message}`);
}
for (const relative of [
  "src/components/ui/background-beams.tsx",
  "public/assets/skins/Steve.png",
  "public/assets/skins/Alex.png",
  "public/assets/face.png",
]) {
  if (existsSync(path.join(root, relative)))
    failures.push(`Excluded source or asset is still present: ${relative}`);
}
const config = JSON.parse(
  readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"),
);
if (
  config.bundle.license !== "GPL-3.0-only" ||
  config.bundle.licenseFile !== "../LICENSE"
)
  failures.push("Bundle GPL metadata is incomplete");
for (const relative of [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "licenses/",
]) {
  const source = `../${relative}`;
  if (!config.bundle.resources?.[source])
    failures.push(`Bundle resource missing: ${relative}`);
}
if (
  !/GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/.test(
    readFileSync(path.join(root, "LICENSE"), "utf8"),
  )
)
  failures.push("Invalid GPLv3 text");
const serialized = `${JSON.stringify({ project: "Voxelight Launcher", version: config.version, packages: inventory.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`) || a.noticeType.localeCompare(b.noticeType) || a.source.localeCompare(b.source) || a.notices.join("\n").localeCompare(b.notices.join("\n"))) }, null, 2)}\n`;
if (write) writeFileSync(inventoryPath, serialized);
if (!existsSync(inventoryPath))
  failures.push(
    "Run node scripts/check-licenses.mjs --write to collect notices",
  );
if (!failures.length && !write) {
  for (const item of inventory)
    for (const filename of item.notices)
      if (!existsSync(path.join(root, filename)))
        failures.push(`Missing collected notice: ${filename}`);
  if (readFileSync(inventoryPath, "utf8") !== serialized)
    failures.push("dependency-inventory.json is stale; rerun with --write");
}
console.log(
  `${inventory.length} third-party packages checked; ${inventory.reduce((count, item) => count + item.notices.length, 0)} notices collected.`,
);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    write
      ? "License notices and dependency inventory updated."
      : "License declarations, collected notices, excluded assets and bundle resources verified.",
  );
}
