// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const buildRuntime = await import("../../scripts/build-runtime.mjs");
let mediumRunner;
try { mediumRunner = await import("../../scripts/run-medium.mjs"); } catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const fixtureTargets = ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc", "i686-pc-windows-gnu"];
const fixtureOptions = {
  platform: "win32", repositoryRoot: "E:\\Workspace With Spaces\\VoxelightLauncher",
  currentDirectory: "E:\\Workspace With Spaces\\VoxelightLauncher", windowsTargets: fixtureTargets,
  cliScript: "C:\\fixture\\tauri.js", environment: { CARGO_TARGET_DIR: "E:\\configured-target", KEEP_FIXTURE: "retained" },
};

function cargoRunnerArguments(invocation) {
  const separator = invocation.args.indexOf("--");
  assert.notEqual(separator, -1, "Tauri dev must receive Cargo runner configuration");
  return invocation.args.slice(separator + 1);
}

test("Windows dev preserves Cargo target/config lookup and adds a Medium runner before Cargo executes the app", () => {
  const invocation = buildRuntime.tauriInvocation(["dev", "--no-watch"], fixtureOptions);
  assert.equal(invocation.cwd, fixtureOptions.currentDirectory);
  assert.deepEqual(invocation.env, fixtureOptions.environment);
  const runnerArgs = cargoRunnerArguments(invocation);
  assert.equal(runnerArgs.filter(value => value === "--config").length, fixtureTargets.length + 1);
  for (const target of ['"cfg(windows)"', ...fixtureTargets.map(JSON.stringify)]) {
    const config = runnerArgs.find(value => value.startsWith(`target.${target}.runner=`));
    assert.ok(config, `runner override missing for ${target}`);
    const command = JSON.parse(config.slice(config.indexOf("=") + 1));
    assert.equal(command[0], process.execPath);
    assert.equal(command[1], win32.join(fixtureOptions.repositoryRoot, "scripts", "run-medium.mjs"));
  }
});

test("runner config comes after user Cargo options and before the application separator without altering app arguments", () => {
  const invocation = buildRuntime.tauriInvocation([
    "dev", "--target", "aarch64-pc-windows-msvc", "--", "--features", "fixture", "--", "a value with spaces", "--flag",
  ], fixtureOptions);
  const args = cargoRunnerArguments(invocation);
  assert.deepEqual(args.slice(0, 2), ["--features", "fixture"]);
  assert.deepEqual(args.slice(args.lastIndexOf("--") + 1), ["a value with spaces", "--flag"]);
  assert.ok(args.indexOf("--config") > args.indexOf("fixture"));
  assert.ok(args.indexOf("--config") < args.lastIndexOf("--"));
});

test("non-Windows dev does not gain runner, integrity or target overrides", () => {
  const args = ["dev", "--", "--features", "fixture"];
  const invocation = buildRuntime.tauriInvocation(args, { ...fixtureOptions, platform: "linux" });
  assert.deepEqual(invocation.args.slice(1), args);
  assert.deepEqual(invocation.env, fixtureOptions.environment);
});

test("Tauri build preserves arguments and uses post-build repair rather than a Cargo dev runner", () => {
  const invocation = buildRuntime.tauriInvocation(["build", "--no-bundle"], fixtureOptions);
  assert.deepEqual(invocation.args.slice(1), ["build", "--no-bundle"]);
  assert.deepEqual(invocation.env, fixtureOptions.environment);
});

test("CLI wrapper forwards real child arguments, cwd, environment and a nonzero exit code", async () => {
  const directory = mkdtempSync(join(tmpdir(), "voxelight-build-wrapper-"));
  try {
    const childScript = join(directory, "fixture-cli.cjs");
    const resultFile = join(directory, "result.json");
    writeFileSync(childScript, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(3), target: process.env.CARGO_TARGET_DIR })); process.exitCode = 23;\n");
    assert.equal(await buildRuntime.runTauri([resultFile, "dev", "value with spaces"], {
      platform: "linux", repositoryRoot, currentDirectory: directory, cliScript: childScript,
      environment: { ...process.env, CARGO_TARGET_DIR: "fixture-target" },
    }), 23);
    assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), {
      cwd: directory, args: ["dev", "value with spaces"], target: "fixture-target",
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Cargo metadata target lookup preserves its configured directory and rejects missing metadata", () => {
  assert.equal(typeof buildRuntime.targetDirectoryFromMetadata, "function", "target paths must come from actual Cargo metadata, not a new shared cache");
  assert.equal(buildRuntime.targetDirectoryFromMetadata('{"target_directory":"E:\\\\fixture\\\\configured-target"}'), "E:\\fixture\\configured-target");
  assert.throws(() => buildRuntime.targetDirectoryFromMetadata("{}"), /target_directory/);
  assert.throws(() => buildRuntime.targetDirectoryFromMetadata('{"target_directory":""}'), /target_directory/);
});

test("all npm desktop build and dev entry points use the integrity-safe Tauri wrapper", () => {
  const { scripts } = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(scripts.tauri, "node scripts/tauri.mjs");
  assert.equal(scripts["desktop:dev"], "node scripts/tauri.mjs dev");
  assert.equal(scripts["desktop:build"], "node scripts/tauri.mjs build");
});

test("Medium runner repairs a freshly relinked executable before each launch and refuses to launch after a repair failure", async () => {
  assert.equal(typeof mediumRunner?.runMedium, "function", "Cargo needs a run-before-launch integrity hook");
  const events = [];
  const options = {
    platform: "win32", repositoryRoot: "E:\\Fixture With Spaces", environment: {}, currentDirectory: "E:\\Fixture With Spaces\\src-tauri",
    execute: async (command, args) => {
      if (command.endsWith("powershell.exe")) {
        events.push({ type: "repair", executable: args.at(-1) });
        return 0;
      }
      events.push({ type: "launch", command, args });
      return 0;
    },
  };
  for (let relink = 0; relink < 2; relink++) {
    events.push({ type: "relinked-low" });
    assert.equal(await mediumRunner.runMedium("E:\\Fixture With Spaces\\target\\debug\\fixture.exe", ["a value", "--flag"], options), 0);
  }
  assert.deepEqual(events.map(event => event.type), ["relinked-low", "repair", "launch", "relinked-low", "repair", "launch"]);
  assert.deepEqual(events[2].args, ["a value", "--flag"]);
  let calls = 0;
  assert.equal(await mediumRunner.runMedium("E:\\fixture.exe", [], {
    ...options, execute: async () => { calls++; return 7; },
  }), 7);
  assert.equal(calls, 1, "repair failure must prevent executable launch");
});

test("native Windows runner changes two freshly generated Low executables from RID 4096 to RID 8192 before launch", { skip: process.platform !== "win32" }, async context => {
  const outputRoot = join(repositoryRoot, "src-tauri", "target");
  mkdirSync(outputRoot, { recursive: true });
  const directory = mkdtempSync(join(outputRoot, "medium-runner-"));
  try {
    const sourceFile = join(directory, "TokenProbe.cs");
    const template = join(directory, "token-probe-template.exe");
    writeFileSync(sourceFile, `using System;
using System.Runtime.InteropServices;
public static class TokenProbe {
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int length, out int needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
  public static void Main() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 8, out token)) throw new Exception("OpenProcessToken failed");
    IntPtr buffer = IntPtr.Zero;
    try {
      int size;
      GetTokenInformation(token, 25, IntPtr.Zero, 0, out size);
      buffer = Marshal.AllocHGlobal(size);
      if (!GetTokenInformation(token, 25, buffer, size, out size)) throw new Exception("GetTokenInformation failed");
      IntPtr sid = Marshal.ReadIntPtr(buffer);
      uint count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
      Console.WriteLine(Marshal.ReadInt32(GetSidSubAuthority(sid, count - 1)));
    } finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); CloseHandle(token); }
  }
}
`);
    const compiler = join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const compiled = spawnSync(compiler, ["/nologo", "/target:exe", `/out:${template}`, sourceFile], { encoding: "utf8", windowsHide: true });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    for (let relink = 0; relink < 2; relink++) {
      const executable = join(directory, `freshly-linked-${relink}.exe`);
      copyFileSync(template, executable);
      const labeled = spawnSync(join(process.env.SystemRoot, "System32", "icacls.exe"), [executable, "/setintegritylevel", "low"], { encoding: "utf8", windowsHide: true });
      assert.equal(labeled.status, 0, labeled.stdout + labeled.stderr);
      const control = spawnSync(executable, [], { encoding: "utf8", windowsHide: true });
      assert.equal(control.status, 0, control.stderr);
      assert.equal(Number(control.stdout.trim()), 4096, "the negative control must really run at Low integrity");
      let observedRid;
      const code = await mediumRunner.runMedium(executable, [], {
        repositoryRoot, currentDirectory: directory,
        execute: async (command, args, options) => {
          const result = spawnSync(command, args, { cwd: options.currentDirectory, env: options.environment, encoding: "utf8", windowsHide: true });
          assert.equal(result.status, 0, result.stdout + result.stderr);
          if (command === executable) observedRid = Number(result.stdout.trim());
          return result.status;
        },
      });
      assert.equal(code, 0);
      assert.equal(observedRid, 8192, "repair must finish before every newly linked executable is launched");
      context.diagnostic(`relink=${relink} directRID=4096 runnerRID=${observedRid}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("post-build repair covers the executable and current installers but NoBundle leaves old installers alone", () => {
  assert.equal(typeof buildRuntime.builtArtifactPaths, "function");
  const files = ["Voxelight Launcher_0.6.0_x64-setup.exe", "ignore.txt"];
  assert.deepEqual(buildRuntime.builtArtifactPaths("E:\\target", ["build", "--no-bundle"], files), ["E:\\target\\release\\voxelight-launcher.exe"]);
  assert.deepEqual(buildRuntime.builtArtifactPaths("E:\\target", ["build"], files), [
    "E:\\target\\release\\voxelight-launcher.exe", "E:\\target\\release\\bundle\\nsis\\Voxelight Launcher_0.6.0_x64-setup.exe",
  ]);
  assert.deepEqual(buildRuntime.builtArtifactPaths("E:\\target", ["build", "--debug", "--no-bundle"], files), ["E:\\target\\debug\\voxelight-launcher.exe"]);
});

test("configured Cargo target outputs are repaired even when an old host executable is still present", () => {
  const directory = mkdtempSync(join(tmpdir(), "voxelight-configured-target-"));
  try {
    const host = join(directory, "release", "voxelight-launcher.exe");
    const configured = join(directory, "x86_64-pc-windows-msvc", "release", "voxelight-launcher.exe");
    for (const executable of [host, configured]) {
      mkdirSync(join(executable, ".."), { recursive: true });
      writeFileSync(executable, "fixture");
    }
    // This fallback is the previous production host-only selection, retained
    // so the regression proves the concrete missing target rather than merely
    // noticing that a new helper is absent.
    const collect = buildRuntime.collectBuiltArtifacts ?? ((root, args) => [buildRuntime.builtArtifactPaths(root, args)[0]]);
    assert.deepEqual(collect(directory, ["build", "--no-bundle"]).sort(), [host, configured].sort());
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("configured artifact discovery is bounded, excludes redirected directories and preserves NoBundle", () => {
  assert.equal(typeof buildRuntime.collectBuiltArtifacts, "function");
  const directory = mkdtempSync(join(tmpdir(), "voxelight-artifact-discovery-"));
  try {
    const target = join(directory, "target");
    const profile = join(target, "x86_64-pc-windows-msvc", "release");
    const executable = join(profile, "voxelight-launcher.exe");
    const setup = join(profile, "bundle", "nsis", "Fixture_0.6.0_x64-setup.exe");
    mkdirSync(join(setup, ".."), { recursive: true });
    writeFileSync(executable, "fixture");
    writeFileSync(setup, "old installer fixture");
    const tooDeep = join(target, "nested", "second", "release", "voxelight-launcher.exe");
    mkdirSync(join(tooDeep, ".."), { recursive: true });
    writeFileSync(tooDeep, "must not be discovered");
    const outside = join(directory, "outside");
    mkdirSync(join(outside, "release"), { recursive: true });
    writeFileSync(join(outside, "release", "voxelight-launcher.exe"), "must not be discovered");
    symlinkSync(outside, join(target, "redirected"), "junction");
    assert.deepEqual(buildRuntime.collectBuiltArtifacts(target, ["build", "--no-bundle"]), [executable]);
    assert.deepEqual(buildRuntime.collectBuiltArtifacts(target, ["build"]), [executable, setup]);
    assert.equal(readFileSync(setup, "utf8"), "old installer fixture");
    assert.deepEqual(buildRuntime.artifactProfileDirectories(target, ["build"]), [profile]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("PowerShell build/signing and installer verification share Cargo metadata output resolution", () => {
  for (const script of ["build.ps1", "desktop.ps1", "verify-installer-ui.ps1"]) {
    const source = readFileSync(join(repositoryRoot, "scripts", script), "utf8");
    assert.match(source, /build-runtime\.mjs/);
    assert.match(source, /--print-target-dir/);
    assert.doesNotMatch(source, /Temp\\VoxelightLauncher\\build/);
  }
});

test("PowerShell artifact reporting, signing and installer selection consume configured profile directories", () => {
  for (const script of ["build.ps1", "desktop.ps1", "verify-installer-ui.ps1"]) {
    const source = readFileSync(join(repositoryRoot, "scripts", script), "utf8");
    assert.match(source, /--print-artifact-dirs/);
    assert.match(source, /ConvertFrom-Json/);
  }
});
