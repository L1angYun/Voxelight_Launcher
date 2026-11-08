// SPDX-License-Identifier: GPL-3.0-only
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, win32 } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const checkoutRoot = fileURLToPath(new URL("../", import.meta.url));

function rustEnvironment(environment, platform) {
  const env = { ...environment };
  if (platform === "win32" && env.USERPROFILE) {
    const cargoBin = win32.join(env.USERPROFILE, ".cargo", "bin");
    if (existsSync(win32.join(cargoBin, "cargo.exe"))) {
      const pathKey = Object.keys(env).find(name => name.toUpperCase() === "PATH");
      const previousPath = pathKey ? env[pathKey] : "";
      for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
      env.PATH = `${cargoBin};${previousPath}`;
    }
  }
  return env;
}

function windowsTargets(environment, currentDirectory) {
  const result = spawnSync("rustc", ["--print", "target-list"], {
    cwd: currentDirectory, env: environment, encoding: "utf8", windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("Rust is required to configure the Windows development runner.");
  const targets = result.stdout.split(/\r?\n/).filter(value => value.includes("-windows-") && /^[a-zA-Z0-9_-]+$/.test(value));
  if (!targets.length) throw new Error("Rust did not report any Windows build targets.");
  return targets;
}

function developmentArguments(args, repositoryRoot, targets) {
  const runner = JSON.stringify([process.execPath, win32.join(repositoryRoot, "scripts", "run-medium.mjs")]);
  // Cargo's --config accepts a TOML array, so executable/script paths are
  // individual arguments even when they contain spaces. No shell parses them.
  // Exact target tables beat cfg tables; cover every Windows target reported
  // by this toolchain as well as cfg(windows), preserving configured targets.
  const configuration = ['cfg(windows)', ...targets].flatMap(target => ["--config", `target.${JSON.stringify(target)}.runner=${runner}`]);
  const separator = args.indexOf("--");
  if (separator < 0) return [...args, "--", ...configuration];
  const applicationSeparator = args.indexOf("--", separator + 1);
  const insertion = applicationSeparator < 0 ? args.length : applicationSeparator;
  return [...args.slice(0, insertion), ...configuration, ...args.slice(insertion)];
}

export function tauriInvocation(args, {
  platform = process.platform,
  repositoryRoot = checkoutRoot,
  environment = process.env,
  currentDirectory = process.cwd(),
  windowsTargets: targets,
  cliScript = require.resolve("@tauri-apps/cli/tauri.js"),
} = {}) {
  const env = rustEnvironment(environment, platform);
  const cliArgs = platform === "win32" && args[0] === "dev"
    ? developmentArguments(args, repositoryRoot, targets ?? windowsTargets(env, currentDirectory))
    : args;
  // Do not relocate Cargo or its cwd. The official CLI invokes Cargo in
  // src-tauri, so src-tauri/.cargo/config.toml still supplies private build
  // configuration. Only the executable's label changes immediately before run.
  return { command: process.execPath, args: [cliScript, ...cliArgs], cwd: currentDirectory, env };
}

export function execute(command, args, { environment = process.env, currentDirectory = process.cwd() } = {}) {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: currentDirectory, env: environment, stdio: "inherit", windowsHide: false });
    child.once("error", reject);
    child.once("close", code => resolveExit(code ?? 1));
  });
}

export async function repairExecutables(paths, {
  platform = process.platform,
  repositoryRoot = checkoutRoot,
  environment = process.env,
  currentDirectory = process.cwd(),
  execute: run = execute,
} = {}) {
  if (platform !== "win32") return 0;
  const powershell = win32.join(environment.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  for (const artifact of paths) {
    const code = await run(powershell, [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      win32.join(repositoryRoot, "scripts", "repair-build-integrity.ps1"), "-Path", artifact,
    ], { environment, currentDirectory });
    if (code !== 0) return code;
  }
  return 0;
}

export function targetDirectoryFromMetadata(json) {
  const value = JSON.parse(json).target_directory;
  if (typeof value !== "string" || !value) throw new Error("Cargo metadata did not provide target_directory.");
  return value;
}

export function targetDirectory({
  platform = process.platform,
  repositoryRoot = checkoutRoot,
  environment = process.env,
} = {}) {
  const result = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
    cwd: join(repositoryRoot, "src-tauri"), env: rustEnvironment(environment, platform), encoding: "utf8", windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error("Could not resolve the Cargo target directory. Check that Rust is installed and Cargo metadata succeeds in src-tauri.");
  return targetDirectoryFromMetadata(result.stdout);
}

export function builtArtifactPaths(target, args, setupFiles = []) {
  const targetArgument = args.indexOf("--target");
  const explicitTarget = targetArgument >= 0 ? args[targetArgument + 1] : args.find(value => value.startsWith("--target="))?.slice(9);
  const root = explicitTarget ? win32.join(target, win32.basename(explicitTarget, ".json")) : target;
  const profile = args.includes("--debug") ? "debug" : "release";
  const profileDirectory = win32.join(root, profile);
  return [
    win32.join(profileDirectory, "voxelight-launcher.exe"),
    ...(args.includes("--no-bundle") ? [] : setupFiles.filter(name => win32.basename(name) === name && name.endsWith("-setup.exe"))
      .map(name => win32.join(profileDirectory, "bundle", "nsis", name))),
  ];
}

function ordinaryPath(path, kind) {
  try {
    const item = lstatSync(path);
    return !item.isSymbolicLink() && (kind === "directory" ? item.isDirectory() : item.isFile());
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

export function artifactProfileDirectories(target, args = ["build"]) {
  if (!ordinaryPath(target, "directory")) return [];
  const profile = args.includes("--debug") ? "debug" : "release";
  const targetArgument = args.indexOf("--target");
  const explicitTarget = targetArgument >= 0 ? args[targetArgument + 1] : args.find(value => value.startsWith("--target="))?.slice(9);
  const roots = explicitTarget ? [join(target, win32.basename(explicitTarget, ".json"))] : [
    target,
    ...readdirSync(target, { withFileTypes: true })
      .filter(item => item.isDirectory() && !item.isSymbolicLink())
      .map(item => join(target, item.name)).sort(),
  ];
  // Cargo configuration and CARGO_BUILD_TARGET can select a triple without a
  // CLI --target. Inspect only host/profile and one child/profile level. Do not
  // read private Cargo settings or follow redirected directories/executables.
  return roots.filter(root => ordinaryPath(root, "directory"))
    .map(root => join(root, profile))
    .filter(directory => ordinaryPath(directory, "directory") && ordinaryPath(join(directory, "voxelight-launcher.exe"), "file"));
}

export function collectBuiltArtifacts(target, args = ["build"]) {
  const artifacts = [];
  for (const directory of artifactProfileDirectories(target, args)) {
    artifacts.push(join(directory, "voxelight-launcher.exe"));
    if (args.includes("--no-bundle")) continue;
    const bundle = join(directory, "bundle");
    const nsis = join(bundle, "nsis");
    if (!ordinaryPath(bundle, "directory") || !ordinaryPath(nsis, "directory")) continue;
    artifacts.push(...readdirSync(nsis).sort()
      .filter(name => /-setup\.exe$/i.test(name) && ordinaryPath(join(nsis, name), "file"))
      .map(name => join(nsis, name)));
  }
  return artifacts;
}

export async function runTauri(args, options = {}) {
  const invocation = tauriInvocation(args, options);
  const code = await execute(invocation.command, invocation.args, { currentDirectory: invocation.cwd, environment: invocation.env });
  if (code !== 0 || (options.platform ?? process.platform) !== "win32" || args[0] !== "build") return code;
  const target = targetDirectory(options);
  const artifacts = collectBuiltArtifacts(target, args);
  if (!artifacts.length) throw new Error(`No ordinary launcher executable was found beneath the Cargo target directory: ${target}`);
  console.log("Medium integrity repair candidates (including existing/cached outputs):");
  return repairExecutables(artifacts, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!["--print-target-dir", "--print-artifact-dirs"].includes(process.argv[2])) {
    console.error("Usage: node scripts/build-runtime.mjs --print-target-dir | --print-artifact-dirs [--debug] [--target <triple>]");
    process.exitCode = 1;
  } else {
    try {
      const target = targetDirectory();
      console.log(process.argv[2] === "--print-target-dir" ? target : JSON.stringify(artifactProfileDirectories(target, ["build", ...process.argv.slice(3)])));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
