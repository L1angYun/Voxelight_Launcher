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
