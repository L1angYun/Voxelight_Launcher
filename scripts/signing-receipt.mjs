// SPDX-License-Identifier: GPL-3.0-only
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectBuiltArtifacts, targetDirectory } from "./build-runtime.mjs";

const receiptName = "signing-receipt.json";
const signingDirectory = "signing-builds";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function samePath(a, b) {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validateRun(target, run) {
  if (!/^[0-9a-f]{16}$/i.test(basename(run)) || !samePath(dirname(run), join(target, signingDirectory))) {
    throw new Error("Select a signing receipt produced by a fresh build.ps1 -PrepareSigning run.");
  }
  for (const directory of [target, dirname(run), run]) {
    if (!lstatSync(directory).isDirectory() || !samePath(realpathSync(directory), directory)) {
      throw new Error("Redirected signing build directories are not accepted.");
    }
  }
}

function shortArtifactPath(item, run) {
  // Both host and Cargo-configured target directories are supported.
  const relativePath = relative(run, item).split(sep).join("/");
  if (!/^(?:[A-Za-z0-9_.-]+\/)?release\/(?:voxelight-launcher\.exe|bundle\/nsis\/[^/]+-setup\.exe)$/i.test(relativePath) ||
      relativePath.startsWith("../")) {
    throw new Error("The signing receipt contains a path outside the eligible build outputs.");
  }
  return relativePath;
}

async function fingerprint(path) {
  const item = lstatSync(path);
  if (!item.isFile() || !samePath(realpathSync(path), path)) {
    throw new Error("Redirected signing artifacts are not accepted.");
  }
  const contents = createHash("sha256");
  for await (const chunk of createReadStream(path)) contents.update(chunk);
  return { size: item.size, sha256: contents.digest("hex") };
}

export async function createSigningReceipt(target, run, noBundle = false) {
  validateRun(target, run);
  const artifacts = collectBuiltArtifacts(run, noBundle ? ["build", "--no-bundle"] : ["build"]);
  if (!artifacts.some((item) => basename(item) === "voxelight-launcher.exe") ||
      (!noBundle && !artifacts.some((item) => item.endsWith("-setup.exe")))) {
    throw new Error("The fresh build did not produce every requested signing artifact.");
  }
  const files = [];
  for (const artifact of artifacts) {
    files.push({ path: shortArtifactPath(artifact, run), ...(await fingerprint(artifact)) });
  }
  const receipt = join(run, receiptName);
  writeFileSync(receipt, JSON.stringify({ schema: 1, noBundle, files }, null, 2) + "\n", { flag: "wx" });
  return receipt;
}

export async function readSigningReceipt(target, file) {
  const run = dirname(file);
  validateRun(target, run);
  if (basename(file) !== receiptName || !lstatSync(file).isFile() || !samePath(realpathSync(file), file)) {
    throw new Error("Select the original signing-receipt.json from the signing build.");
  }
  const { schema, noBundle, files } = JSON.parse(readFileSync(file, "utf8"));
  if (schema !== 1 || typeof noBundle !== "boolean" || !Array.isArray(files) || files.length === 0) {
    throw new Error("Invalid signing build receipt.");
  }
  const eligible = new Set(collectBuiltArtifacts(run, noBundle ? ["build", "--no-bundle"] : ["build"])
    .map((artifact) => shortArtifactPath(artifact, run)));
  const recorded = new Set();
  const paths = [];
  for (const { path, size, sha256 } of files) {
    if (recorded.has(path) || !eligible.has(path)) throw new Error("Receipt does not match its original build outputs.");
    recorded.add(path);
    const artifact = join(run, path);
    const actual = await fingerprint(artifact);
    if (actual.size !== size || actual.sha256 !== sha256) throw new Error(`Build artifact changed: ${path}`);
    paths.push(artifact);
  }
  if (recorded.size !== eligible.size || !paths.some((item) => basename(item) === "voxelight-launcher.exe") ||
      (!noBundle && !paths.some((item) => item.endsWith("-setup.exe")))) {
    throw new Error("Receipt does not match its original build outputs.");
  }
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [mode, arg, extra] = process.argv.slice(2);
    if (mode === "create" && arg && (extra === undefined || extra === "--no-bundle")) {
      const run = resolve(arg);
      console.log(await createSigningReceipt(dirname(dirname(run)), run, extra === "--no-bundle"));
    } else if (mode === "read" && arg && extra === undefined) {
      console.log(JSON.stringify(await readSigningReceipt(targetDirectory({ repositoryRoot }), resolve(arg))));
    } else {
      throw new Error("Usage: signing-receipt.mjs create <fresh build directory> [--no-bundle] | read <receipt>");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
