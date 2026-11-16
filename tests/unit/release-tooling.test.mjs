// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = name => readFileSync(join(root, name), "utf8");
const json = name => JSON.parse(source(name));

test("public source links match the migrated repository from the README to the NSIS metadata", () => {
  const repository = "https://github.com/L1angYun/Voxelight_Launcher";
  const readme = source("README.md");
  const pkg = json("package.json");
  const cargo = source("src-tauri/Cargo.toml");
  const tauri = json("src-tauri/tauri.conf.json");
  assert.equal(readme.match(/^Source repository: (\S+)$/m)?.[1], repository);
  assert.equal(pkg.homepage, repository);
  assert.equal(pkg.repository.url, `git+${repository}.git`);
  assert.equal(cargo.match(/^homepage = "([^"]+)"$/m)?.[1], repository);
  assert.equal(cargo.match(/^repository = "([^"]+)"$/m)?.[1], repository);
  assert.equal(tauri.bundle.homepage, repository);
  assert.match(source(`src-tauri/${tauri.bundle.windows.nsis.template}`), /"URLInfoAbout" "\$\{HOMEPAGE\}"/);
  assert.match(readme, /scripts\/build\.ps1 -NoBundle/);
  assert.match(readme, /source:package.*separate|separately.*source:package/i);
});

test("the declared Node LTS minimum satisfies the locked jsdom floor and the README names the supported toolchains", () => {
  const pkg = json("package.json");
  const lock = json("package-lock.json");
  const readme = source("README.md");
  const cargo = source("src-tauri/Cargo.toml");
  const lockedNode22 = lock.packages["node_modules/jsdom"].engines.node.match(/\^(22\.\d+\.\d+)/)?.[1];
  assert.ok(lockedNode22, "update the supported LTS check when jsdom's Node ranges change");
  assert.equal(pkg.engines?.node, `^${lockedNode22} || >=24.0.0`);
  assert.equal(lock.packages[""].engines?.node, pkg.engines.node);
  assert.ok(readme.includes(`Node.js ${lockedNode22}`));
  const minimumRust = cargo.match(/^rust-version = "([^"]+)"$/m)?.[1];
  assert.ok(minimumRust);
  assert.ok(readme.includes(`Rust ${minimumRust}`));
});

test("Windows desktop Cargo check and test load the nested Cargo configuration", { skip: process.platform !== "win32" }, () => {
  const work = mkdtempSync(join(tmpdir(), "voxelight-release-cargo-"));
  try {
    mkdirSync(join(work, "scripts"));
    mkdirSync(join(work, "src-tauri", "src"), { recursive: true });
    mkdirSync(join(work, "src-tauri", ".cargo"));
    copyFileSync(join(root, "scripts", "desktop.ps1"), join(work, "scripts", "desktop.ps1"));
    writeFileSync(join(work, "src-tauri", "Cargo.toml"), '[package]\nname = "cargo-cwd-fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ndoctest = false\n');
    writeFileSync(join(work, "src-tauri", "Cargo.lock"), 'version = 4\n\n[[package]]\nname = "cargo-cwd-fixture"\nversion = "0.1.0"\n');
    writeFileSync(join(work, "src-tauri", ".cargo", "config.toml"), '[build]\nrustflags = ["--cfg", "voxelight_config_fixture"]\n');
    writeFileSync(join(work, "src-tauri", "src", "lib.rs"), '#![allow(unexpected_cfgs)]\n#[cfg(not(voxelight_config_fixture))]\ncompile_error!("nested Cargo configuration is missing");\n#[test] fn fixture() {}\n');
    const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const env = { ...process.env, CARGO_NET_OFFLINE: "true" };
    for (const key of Object.keys(env)) {
      if (/^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_BUILD_TARGET|CARGO_TARGET_DIR)$/i.test(key)) delete env[key];
    }
    const outcomes = ["check", "test"].map(action => {
      const child = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(work, "scripts", "desktop.ps1"), "-Action", action], { cwd: work, env, encoding: "utf8", windowsHide: true });
      return { action, code: child.status, details: `${child.stdout}${child.stderr}` };
    });
    for (const { action, code, details } of outcomes) assert.equal(code, 0, `${action}\n${details}`);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test("smoke defaults use the configured Cargo output, never an old checkout-local build", { skip: process.platform !== "win32" }, async () => {
  const runtime = await import("../../scripts/build-runtime.mjs");
  const work = mkdtempSync(join(tmpdir(), "voxelight-release-smoke-"));
  try {
    const configured = join(work, "configured-target");
    mkdirSync(join(work, "src-tauri", ".cargo"), { recursive: true });
    mkdirSync(join(work, "src-tauri", "src"));
    writeFileSync(join(work, "src-tauri", "Cargo.toml"), '[package]\nname = "smoke-target-fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(work, "src-tauri", "src", "lib.rs"), "");
    writeFileSync(join(work, "src-tauri", ".cargo", "config.toml"), `[build]\ntarget-dir = ${JSON.stringify(configured)}\n`);
    const exe = join(configured, "x86_64-pc-windows-msvc", "debug", "voxelight-launcher.exe");
    const release = join(configured, "x86_64-pc-windows-msvc", "release", "voxelight-launcher.exe");
    const setup = join(release, "..", "bundle", "nsis", "Voxelight Launcher_0.6.0_x64-setup.exe");
    for (const artifact of [exe, release, setup]) {
      mkdirSync(join(artifact, ".."), { recursive: true });
      writeFileSync(artifact, "test fixture; never executable");
    }
    const env = { ...process.env, CARGO_NET_OFFLINE: "true" };
    for (const key of Object.keys(env)) {
      if (/^(CARGO_BUILD_TARGET|CARGO_TARGET_DIR)$/i.test(key)) delete env[key];
    }
    const options = { repositoryRoot: work, environment: env };
    const legacyDebug = join(work, "src-tauri", "target", "debug", "voxelight-launcher.exe");
    const legacySetup = join(work, "src-tauri", "target", "release", "bundle", "nsis", "Voxelight Launcher_0.6.0_x64-setup.exe");
    const launcher = runtime.resolveSmokeArtifact?.("launcher", options) ?? legacyDebug;
    const installer = runtime.resolveSmokeArtifact?.("installer", { ...options, productName: "Voxelight Launcher", version: "0.6.0" }) ?? legacySetup;
    assert.equal(launcher, exe);
    assert.equal(installer, setup);
    const custom = join(work, "copied-launcher.exe");
    assert.equal(runtime.resolveSmokeArtifact("launcher", { ...options, environment: { ...env, SMOKE_BINARY: custom } }), resolve(custom));
    const stale = join(configured, "debug", "voxelight-launcher.exe");
    mkdirSync(join(stale, ".."), { recursive: true });
    writeFileSync(stale, "stale fixture");
    assert.throws(() => runtime.resolveSmokeArtifact("launcher", options), /multiple.*SMOKE_BINARY/i);
    assert.equal(runtime.resolveSmokeArtifact("launcher", { ...options, environment: { ...env, CARGO_BUILD_TARGET: "x86_64-pc-windows-msvc" } }), exe);
  } finally { rmSync(work, { recursive: true, force: true }); }
});
