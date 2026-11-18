import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/check-toolchain.mjs", import.meta.url));
const rustAdvisory = {
  advisory: { id: "RUSTSEC-2099-0001", cvss: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N" },
  package: { name: "example-crate" },
};
const npmId = "GHSA-2345-6789-cfgh";

async function checker() {
  return import("../../scripts/check-toolchain.mjs");
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "voxelight-toolchain-fixture-"));
  t.after(() => rmSync(root, { recursive: true }));
  mkdirSync(path.join(root, "src-tauri"));
  mkdirSync(path.join(root, "scripts"));
  writeFileSync(
    path.join(root, "src-tauri", "Cargo.toml"),
    '[package]\nname = "fixture"\nrust-version = "1.90"\n',
  );
  return root;
}

function allow(root, entries) {
  writeFileSync(path.join(root, "scripts", "advisory-allowlist.json"), JSON.stringify(entries));
}

function reply(stdout = "", status = 0, stderr = "") {
  return { stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout), status, stderr };
}

function missing() {
  return { error: Object.assign(new Error("fixture command absent"), { code: "ENOENT" }) };
}

function capture(root, spawn) {
  const lines = [];
  return {
    lines,
    options: {
      root,
      spawn,
      env: {},
      platform: "linux",
      today: "2098-10-13",
      stdout: (line) => lines.push(line),
      stderr: (line) => lines.push(line),
    },
  };
}

function runWithFixturePath(root, args, bin = path.join(root, "no-programs")) {
  const fixtureScript = path.join(root, "scripts", "check-toolchain.mjs");
  cpSync(script, fixtureScript);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["path", "npm_execpath"].includes(key.toLowerCase()),
  ));
  // Both fixture modes only seek Rust programs; no dependency resolution or network.
  env.PATH = bin;
  return spawnSync(process.execPath, [fixtureScript, ...args], {
    encoding: "utf8", windowsHide: true, cwd: root, env,
  });
}

test("MSRV CLI reads the manifest and skips missing Rust by default, failing in strict mode", (t) => {
  const root = fixture(t);
  writeFileSync(
    path.join(root, "src-tauri", "Cargo.toml"),
    '[package]\nname = "fixture"\nrust-version = "1.91" # fixture\n',
  );
  const optional = runWithFixturePath(root, ["--msrv"]);
  assert.equal(optional.status, 0, optional.stderr);
  assert.match(optional.stdout, /SKIPPED: Rust 1\.91/);
  assert.match(optional.stdout, /msrv: skipped/);
  const strict = runWithFixturePath(root, ["--msrv", "--strict"]);
  assert.equal(strict.status, 2);
  assert.match(strict.stderr, /msrv: failed.*1\.91/);
});

test("cargo-only audit CLI explicitly skips without optional scanners", (t) => {
  const result = runWithFixturePath(fixture(t), ["--audit", "--only=cargo"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SKIPPED: no Rust advisory scanner.*cargo-audit.*osv-scanner/);
  assert.match(result.stdout, /audit cargo: skipped/);
  assert.doesNotMatch(result.stdout, /audit npm:/);
});

test("MSRV selects an installed toolchain that matches patch-omitted rust-version", async (t) => {
  const { runToolchain } = await checker();
  const root = fixture(t);
  const calls = [];
  const info = capture(root, (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "rustup") {
      return reply("stable-x86_64-pc-windows-msvc (default)\n1.90.0-x86_64-pc-windows-msvc\n");
    }
    return reply();
  });
  assert.equal(runToolchain(["--msrv", "--strict"], info.options), 0);
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ["rustup", ["toolchain", "list"]],
    ["cargo", ["+1.90.0-x86_64-pc-windows-msvc", "check", "--locked", "--all-targets"]],
  ]);
  assert.equal(calls[1].options.cwd, path.join(root, "src-tauri"));
  assert.equal(calls[1].options.env.CARGO_TARGET_DIR, path.join(root, "src-tauri", "target", "msrv"));
  assert.match(info.lines.join("\n"), /msrv: ok/);
});

test("failed MSRV compilation and rustup failures report failed rather than skipped", async (t) => {
  const { runToolchain } = await checker();
  const root = fixture(t);
  const compile = capture(root, (cmd) => cmd === "rustup" ? reply("1.90.0\n") : reply("", 101));
  assert.equal(runToolchain(["--msrv"], compile.options), 1);
  assert.match(compile.lines.join("\n"), /msrv: failed/);
  const probe = capture(root, () => reply("", 1));
  assert.equal(runToolchain(["--msrv"], probe.options), 1);
  assert.match(probe.lines.join("\n"), /msrv: failed/);
});

test("the Rust audit path consumes real subprocess JSON from an offline scanner fixture", async (t) => {
  const { runToolchain } = await checker();
  const root = fixture(t);
  const fixtureScript = path.join(root, "fake-cargo.cjs");
  const scannerJson = { vulnerabilities: { found: true, count: 1, list: [rustAdvisory] }, warnings: {} };
  writeFileSync(fixtureScript, [
    'if (process.argv.slice(2).join(" ") === "audit --version") { console.log("cargo-audit fixture"); }',
    'else if (process.argv.slice(2).join(" ") === "audit --file Cargo.lock --json") {',
    "  console.log(" + JSON.stringify(JSON.stringify(scannerJson)) + ");",
    "  process.exitCode = 1;",
    "} else { process.exitCode = 5; }",
  ].join("\n"));
  const info = capture(root, (cmd, args, options) => {
    assert.equal(cmd, "cargo");
    // Resolve the test shim to the existing Node executable so this also works on
    // Windows without executing .cmd files or newly-created .exe files.
    return spawnSync(process.execPath, [fixtureScript, ...args], { ...options, env: process.env });
  });
  const run = () => runToolchain(["--audit", "--only=cargo"], info.options);
  assert.equal(run(), 1, info.lines.join("\n"));
  assert.match(info.lines.join("\n"), /RUSTSEC-2099-0001.*example-crate/);
  allow(root, [{
    id: "RUSTSEC-2099-0001", package: "example-crate", reason: "fixture", expires: "2098-10-13",
  }]);
  info.lines.length = 0;
  assert.equal(run(), 0, info.lines.join("\n"));
  assert.match(info.lines.join("\n"), /RUSTSEC-2099-0001.*allowlisted/);
});

test("RustSec allowlisting is scoped to the exact advisory and package and expires", async (t) => {
  const { runToolchain } = await checker();
  const root = fixture(t);
  const lockJson = {
    vulnerabilities: { found: true, count: 1, list: [rustAdvisory] },
    warnings: {},
  };
  const calls = [];
  const info = capture(root, (cmd, args, options) => {
    assert.equal(cmd, "cargo");
    assert.equal(options.cwd, path.join(root, "src-tauri"));
    calls.push(args);
    return args.includes("--version") ? reply("cargo-audit fixture") : reply(lockJson, 1);
  });
  const run = () => runToolchain(["--audit", "--only=cargo"], info.options);
  const rule = { id: "RUSTSEC-2099-0001", package: "example-crate",
    reason: "A local fixture reason", expires: "2098-10-13" };
  assert.equal(run(), 1);
  assert.match(info.lines.join("\n"), /RUSTSEC-2099-0001.*example-crate.*moderate/);
  assert.deepEqual(calls, [["audit", "--version"], ["audit", "--file", "Cargo.lock", "--json"]]);
  allow(root, [rule]);
  assert.equal(run(), 0);
  allow(root, [{ ...rule, package: "different-crate" }]);
  assert.equal(run(), 1);
  allow(root, [{ ...rule, expires: "2098-10-12" }]);
  assert.equal(run(), 1);
  assert.match(info.lines.join("\n"), /allowlist.*expired/);
  allow(root, [{ ...rule, expires: "2098-02-30" }]);
  assert.equal(run(), 1);
  assert.match(info.lines.join("\n"), /allowlist.*invalid/);
  assert.doesNotMatch(info.lines.join("\n"), /A local fixture reason/);
});

test("npm audit reports the underlying advisory once through transitive via references", async (t) => {
  const { runToolchain } = await checker();
  const root = fixture(t);
  const objects = {
    first: { name: "first", severity: "high", via: ["second"] },
    second: { name: "second", severity: "high", via: ["@fixture/inner", "first"] },
    "@fixture/inner": { name: "@fixture/inner", severity: "high", via: [{
      source: 1212121,
      name: "@fixture/inner",
      dependency: "@fixture/inner",
      severity: "high",
      url: "https://github.com/advisories/" + npmId,
    }] },
    low: { name: "low", severity: "low", via: [{
      source: 2323232, name: "low", severity: "low", url: "https://example.invalid/notice",
    }] },
  };
  const invoked = [];
  const info = capture(root, (cmd, args) => {
    invoked.push([cmd, args]);
    return reply({ auditReportVersion: 2, vulnerabilities: objects, metadata: {} });
  });
  assert.equal(runToolchain(["--audit", "--only=npm"], info.options), 1);
  assert.deepEqual(invoked, [["npm", ["audit", "--audit-level=moderate", "--json"]]]);
  assert.deepEqual(info.lines.filter((line) => line.includes(npmId)).length, 1);
  assert.match(info.lines.join("\n"), /npm:2323232.*low/);
  assert.doesNotMatch(info.lines.join("\n"), /first|second|example\.invalid/);
  allow(root, [
    { id: npmId, package: "@fixture/inner", expires: "2098-11-01", reason: "fixture" },
    { id: "npm:2323232", package: "low", expires: "2098-11-01", reason: "fixture" },
  ]);
  assert.equal(runToolchain(["--audit", "--only=npm"], info.options), 0);
});

test("unresolved npm via entries and invalid or failed scanner responses fail closed", async (t) => {
  const { runToolchain } = await checker();
  const root = fixture(t);
  const responses = [
    reply({ auditReportVersion: 2, vulnerabilities: { foo: { via: ["bar"] } } }),
    reply({ auditReportVersion: 2, vulnerabilities: { foo: { via: ["foo"] } } }),
    reply({ auditReportVersion: 2, vulnerabilities: {} }, 2),
    reply({ error: { code: "ENETUNREACH" } }, 1),
    reply("not json"),
  ];
  for (const response of responses) {
    const info = capture(root, () => response);
    assert.equal(runToolchain(["--audit", "--only=npm"], info.options), 1);
    assert.match(info.lines.join("\n"), /audit npm: failed/);
  }
});

test("Rust audit falls back to OSV but does not confuse an installed scanner failure with absence", async (t) => {
  const { runToolchain } = await checker();
  const root = fixture(t);
  const info = capture(root, (cmd, args) => {
    if (cmd === "cargo") return reply("", 101, "error: no such command: 'audit'");
    assert.equal(cmd, "osv-scanner");
    if (args.includes("--version")) return reply("osv-scanner version: 2.5.0");
    assert.deepEqual(args.slice(0, 2), ["scan", "source"]);
    assert.ok(args.includes("--lockfile=Cargo.lock"));
    assert.ok(args.includes("--format"));
    return reply({ results: [{ packages: [{ package: { name: "example-crate" },
      vulnerabilities: [{ id: "RUSTSEC-2099-0001" }] }] }] }, 1);
  });
  assert.equal(runToolchain(["--audit", "--only=cargo"], info.options), 1);
  assert.match(info.lines.join("\n"), /RUSTSEC-2099-0001.*example-crate/);
  const broken = capture(root, (cmd) => {
    assert.equal(cmd, "cargo");
    return reply("", 1, "installed scanner probe failed");
  });
  assert.equal(runToolchain(["--audit", "--only=cargo"], broken.options), 1);
  assert.doesNotMatch(broken.lines.join("\n"), /skipped/);
});

test("npm audit requires a runnable CLI and Windows resolves npm with or without npm_execpath", async (t) => {
  const { npmAuditInvocation, runToolchain } = await checker();
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const adjacent = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const installed = "D:\\my node\\npm-cli.js";
  const args = ["audit", "--audit-level=moderate", "--json"];
  assert.deepEqual(npmAuditInvocation({
    platform: "win32", execPath: node, env: { npm_execpath: installed }, isFile: (file) => file === installed,
  }), { command: node, args: [installed, ...args] });
  assert.deepEqual(npmAuditInvocation({
    platform: "win32", execPath: node, env: {}, isFile: (file) => file === adjacent,
  }), { command: node, args: [adjacent, ...args] });
  assert.deepEqual(npmAuditInvocation({
    platform: "win32", execPath: node, env: {}, isFile: () => false,
  }), { command: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd audit --audit-level=moderate --json"] });

  const root = fixture(t);
  const unavailable = capture(root, () => missing());
  assert.equal(runToolchain(["--audit", "--only=npm"], unavailable.options), 1);
  assert.match(unavailable.lines.join("\n"), /audit npm: failed/);
});
