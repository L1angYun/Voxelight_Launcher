// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
let cachedProbe;

function probeConsumers() {
  if (cachedProbe) return cachedProbe;
  const directory = mkdtempSync(join(tmpdir(), "voxelight-powershell-array-"));
  const script = join(directory, "probe.ps1");
  try {
    // Execute the actual AST nodes from each production consumer. Only the
    // resolver and filesystem existence checks are stubbed; no build/signing
    // operation, installer launch, or permission change is performed.
    writeFileSync(script, `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = '${repositoryRoot.replaceAll("'", "''")}'
$tokens = $null
$parseErrors = $null
$build = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts/build.ps1'), [ref]$tokens, [ref]$parseErrors)
$definition = $build.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ArtifactDirectories'}, $true)
if (-not $definition) { throw 'Production artifact resolver function was not found.' }
Invoke-Expression $definition.Extent.Text
$nodeCmd = { $global:LASTEXITCODE = 0; $script:fixtureJson }
$desktop = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts/desktop.ps1'), [ref]$tokens, [ref]$parseErrors)
$profileLoop = $desktop.Find({param($node) $node -is [Management.Automation.Language.ForEachStatementAst] -and $node.Variable.VariablePath.UserPath -eq 'profile'}, $true)
if (-not $profileLoop) { throw 'Production signing artifact loop was not found.' }
$installer = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'scripts/verify-installer-ui.ps1'), [ref]$tokens, [ref]$parseErrors)
$candidateAssignment = $installer.Find({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$installerCandidates'}, $true)
if (-not $candidateAssignment) { throw 'Production installer candidate assignment was not found.' }
function Test-Path { param($LiteralPath, $PathType) return $script:fixturePathExists }
$profiles = @((Join-Path ([IO.Path]::GetTempPath()) 'voxelight-fixture-host/release'), (Join-Path ([IO.Path]::GetTempPath()) 'voxelight-fixture-triple/release'))
$cases = @(@{name='empty'; json='[]'}, @{name='multiple'; json=ConvertTo-Json -InputObject $profiles -Compress})
$records = @()
foreach ($case in $cases) {
  $script:fixtureJson = $case.json
  $profileJson = $case.json
  $observed = @()
  $failure = $null
  try { $observed = @(Get-ArtifactDirectories) } catch { $failure = $_.Exception.Message }
  $records += @{consumer='build'; case=$case.name; count=$observed.Count; values=$observed; error=$failure}
  $artifacts = @()
  $script:fixturePathExists = $false
  $failure = $null
  try { . ([scriptblock]::Create($profileLoop.Extent.Text)) } catch { $failure = $_.Exception.Message }
  $records += @{consumer='sign'; case=$case.name; count=$artifacts.Count; values=$artifacts; error=$failure}
  $installerCandidates = @()
  $script:fixturePathExists = $true
  $config = @{version='0.6.0'}
  $failure = $null
  try { . ([scriptblock]::Create($candidateAssignment.Extent.Text)) } catch { $failure = $_.Exception.Message }
  $records += @{consumer='installer'; case=$case.name; count=$installerCandidates.Count; values=$installerCandidates; error=$failure}
}
@{version=$PSVersionTable.PSVersion.ToString(); profiles=$profiles; records=$records} | ConvertTo-Json -Depth 10 -Compress
`);
    const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    cachedProbe = JSON.parse(result.stdout.trim());
    assert.match(cachedProbe.version, /^5\./, "exercise Windows PowerShell 5 array semantics");
    return cachedProbe;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const consumer of ["build", "sign", "installer"]) {
  test(`Windows PowerShell 5 ${consumer} consumer flattens zero and multiple Cargo profile paths`, { skip: process.platform !== "win32" }, context => {
    const probe = probeConsumers();
    for (const fixture of ["empty", "multiple"]) {
      const record = probe.records.find(value => value.consumer === consumer && value.case === fixture);
      assert.ok(record, `${consumer}/${fixture}`);
      assert.equal(record.error, null, `${consumer}/${fixture}: ${record.error}`);
      assert.equal(record.count, fixture === "empty" ? 0 : 2, `${consumer}/${fixture} must enumerate paths, never an inner Object[]`);
      if (fixture === "multiple") {
        assert.equal(record.values.every(value => typeof value === "string"), true);
        const expected = probe.profiles.map(profile => consumer === "build" ? profile : join(profile,
          ...(consumer === "sign" ? ["voxelight-launcher.exe"] : ["bundle", "nsis", "Voxelight Launcher_0.6.0_x64-setup.exe"])));
        assert.deepEqual(record.values, expected);
      }
      context.diagnostic(`PowerShell ${probe.version} ${consumer}/${fixture}: ${record.count} paths`);
    }
  });
}
