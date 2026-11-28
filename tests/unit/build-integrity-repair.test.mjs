import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/repair-build-integrity.ps1');
const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const icacls = join(process.env.SystemRoot || 'C:/Windows', 'System32/icacls.exe');
const windowsOnly = { skip: process.platform !== 'win32' };

function invoke(args) {
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { encoding: 'utf8' });
}

function acl(file) {
  const result = spawnSync(icacls, [file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function dacl(file) {
  const quoted = file.replaceAll("'", "''");
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath '${quoted}').GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('repair changes only an explicit exe integrity label and preserves its parent and DACL', windowsOnly, () => {
  const directory = mkdtempSync(join(tmpdir(), 'voxelight integrity repair '));
  const file = join(directory, 'fixture setup.exe');
  try {
    writeFileSync(file, 'fixture, never executed');
    assert.equal(spawnSync(icacls, [file, '/setintegritylevel', 'low']).status, 0);
    const originalDacl = dacl(file);
    const parentAcl = acl(directory);
    const parentDacl = dacl(directory);
    const result = invoke(['-Path', file]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(acl(file), /Medium Mandatory Level|S-1-16-8192/);
    assert.doesNotMatch(acl(file), /Low Mandatory Level|S-1-16-4096/);
    assert.equal(dacl(file), originalDacl);
    assert.equal(acl(directory), parentAcl);
    assert.equal(dacl(directory), parentDacl);
    assert.equal(readFileSync(file, 'utf8'), 'fixture, never executed');
    assert.equal(invoke(['-Path', file]).status, 0, 'repair is idempotent');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('repair rejects directories and non-executables without changing directory integrity', windowsOnly, () => {
  const directory = mkdtempSync(join(tmpdir(), 'voxelight-repair-reject-'));
  const file = join(directory, 'fixture.txt');
  try {
    writeFileSync(file, 'fixture');
    const original = acl(directory);
    assert.notEqual(invoke(['-Path', directory]).status, 0);
    assert.notEqual(invoke(['-Path', file]).status, 0);
    assert.equal(acl(directory), original);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('repair fails for a missing explicit artifact instead of claiming success', windowsOnly, () => {
  assert.notEqual(invoke(['-Path', join(tmpdir(), 'voxelight-missing-artifact.exe')]).status, 0);
});

const quote = value => `'${String(value).replaceAll("'", "''")}'`;

// Runs the Setup artifact repair exactly as scripts/build.ps1 defines it (the
// function is taken from the build script's AST), against two fixture files.
// Nothing is built, signed or launched.
test('build.ps1 restores Medium integrity on both Setup artifacts', windowsOnly, () => {
  const directory = mkdtempSync(join(tmpdir(), 'voxelight build repair '));
  const setupExe = join(directory, 'VoxelightLauncher-0.0.0-x64-setup.exe');
  const nsisExe = join(directory, 'Voxelight Launcher_0.0.0_x64-nsis.exe');
  const logPath = join(directory, 'build.log');
  const resultPath = join(directory, 'result.json');
  const probe = join(directory, 'probe.ps1');
  try {
    for (const file of [setupExe, nsisExe]) {
      writeFileSync(file, 'fixture, never executed');
      assert.equal(spawnSync(icacls, [file, '/setintegritylevel', 'low']).status, 0);
    }
    writeFileSync(probe, `$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$build = [Management.Automation.Language.Parser]::ParseFile(${quote(resolve('scripts/build.ps1'))}, [ref]$tokens, [ref]$parseErrors)
$definition = $build.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Repair-SetupArtifactIntegrity'}, $true)
if (-not $definition) { throw 'The Setup artifact repair function was not found in build.ps1.' }
$start = $definition.Extent.StartOffset
$end = $definition.Extent.EndOffset
$repairChildren = @($build.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'powershell.exe' -and $node.Extent.Text -match '(?i)\\$repairScript'}, $true))
$outside = @($repairChildren | Where-Object { $_.Extent.StartOffset -lt $start -or $_.Extent.EndOffset -gt $end }).Count
$callSites = @($build.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Repair-SetupArtifactIntegrity'}, $true) | ForEach-Object { $_.Extent.Text })
$script:failures = @()
function Write-Fail([string]$Message) { $script:failures += $Message }
Invoke-Expression $definition.Extent.Text
$code = Repair-SetupArtifactIntegrity -RepairScript ${quote(script)} -Targets @(${quote(setupExe)}, ${quote(nsisExe)}) -LogPath ${quote(logPath)}
@{ code = $code; failures = @($script:failures); outside = $outside; callSites = $callSites } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(resultPath)} -Encoding UTF8
`);
    const run = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const result = JSON.parse(readFileSync(resultPath, 'utf8').replace(/^﻿/, ''));
    assert.deepEqual(result.failures, [], run.stdout + run.stderr);
    assert.equal(result.code, 0, run.stdout + run.stderr);
    assert.equal(result.outside, 0, 'build.ps1 must run the repair script only through Repair-SetupArtifactIntegrity');
    assert.equal(result.callSites.length, 1);
    assert.match(result.callSites[0], /-Targets @\(\$releaseAssetPath, \$rawNsisPath\)/);
    for (const file of [setupExe, nsisExe]) {
      assert.match(acl(file), /Medium Mandatory Level|S-1-16-8192/, file);
      assert.doesNotMatch(acl(file), /Low Mandatory Level|S-1-16-4096/, file);
      assert.equal(readFileSync(file, 'utf8'), 'fixture, never executed');
    }
    // Windows PowerShell 5 Tee-Object writes UTF-16 LE with a BOM.
    const rawLog = readFileSync(logPath);
    const log = rawLog[0] === 0xff && rawLog[1] === 0xfe ? rawLog.toString('utf16le') : rawLog.toString('utf8');
    assert.match(log, /Medium integrity: .*VoxelightLauncher-0\.0\.0-x64-setup\.exe/);
    assert.match(log, /Medium integrity: .*Voxelight Launcher_0\.0\.0_x64-nsis\.exe/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
