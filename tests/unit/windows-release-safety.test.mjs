// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" };

function probePowerShell(script) {
  const work = mkdtempSync(join(tmpdir(), "voxelight-release-contract-"));
  try {
    const probe = join(work, "probe.ps1");
    writeFileSync(probe, `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = $env:VOXELIGHT_FIXTURE_ROOT
$work = $env:VOXELIGHT_FIXTURE_WORK
function Read-ScriptAst([string]$Name) {
    $tokens = $null
    $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $root $Name), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
    return $ast
}
function Add-FunctionText($Ast, [string]$Name) {
    $definition = $Ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $Name}, $true)
    if (-not $definition) { throw 'Probe cannot find production function' }
    return $definition.Extent.Text
}
${script}
`);
    const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probe], {
      encoding: "utf8", windowsHide: true,
      env: { ...process.env, VOXELIGHT_FIXTURE_ROOT: root, VOXELIGHT_FIXTURE_WORK: work },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim());
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("H09 installer entry points preflight the shared registration before setup", windowsOnly, () => {
  const silent = readFileSync(join(root, "scripts/smoke-install.mjs"), "utf8");
  const ui = readFileSync(join(root, "scripts/verify-installer-ui.ps1"), "utf8");
  const silentGate = silent.search(/^\s*assertCleanInstallerAccount\(config\.productName(?:, [^)]*)?\);/m);
  const uiGate = ui.search(/^\s*Assert-CleanInstallerAccount\s+\$config\.productName/m);
  assert.ok(silentGate >= 0 && silentGate < silent.indexOf('const installer ='), "silent smoke must refuse an existing registration before finding/running installer");
  assert.ok(uiGate >= 0 && uiGate < ui.indexOf('Add-Type -AssemblyName'), "UI smoke must refuse an existing registration before setup");
});

test("H09 existing and unverifiable installer registrations fail closed without registry access", windowsOnly, () => {
  const result = probePowerShell(String.raw`
$installerSafety = Read-ScriptAst 'scripts/installer-safety.ps1'
Invoke-Expression (Add-FunctionText $installerSafety 'Assert-CleanInstallerAccount')
function Get-VoxelightInstallRegistration {
    if ($script:registryFixture -eq 'error') { throw 'fixture access denied' }
    if ($script:registryFixture -eq 'present') { return 'CurrentUser/Registry64/fixture-registry-path' }
}
$result = @{}
foreach ($script:registryFixture in @('absent','present','error')) {
  try { Assert-CleanInstallerAccount 'Voxelight Launcher'; $result[$script:registryFixture] = 'allowed' }
  catch { $result[$script:registryFixture] = $_.Exception.Message }
}
$result | ConvertTo-Json -Compress
`);
  assert.equal(result.absent, "allowed");
  assert.match(result.present, /existing .* registration.*dedicated Windows account or VM/i);
  assert.match(result.error, /cannot verify.*dedicated Windows account or VM/i);
});

test("B01 clean-extract instructions document the verified direct Debug link command", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const verification = readme.slice(readme.indexOf("## Verification"));
  const paragraph = verification.match(/^To verify a released source ZIP,.*$/m)?.[0];
  assert.ok(paragraph, "The released source ZIP instructions should be written explicitly");
  assert.ok(paragraph.includes("npm run tauri -- build --no-bundle --no-sign --debug -- --locked"), paragraph);
  assert.doesNotMatch(paragraph, /build\.ps1 -NoBundle/);
});

test("H09 registered path contract matches the current NSIS template and retains the legacy vendor name", windowsOnly, () => {
  const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const nsis = readFileSync(join(root, "src-tauri", config.bundle.windows.nsis.template), "utf8");
  const nsisValue = name => {
    const match = [...nsis.matchAll(/^!define (\w+) "([^"]+)"$/gm)].find(([, id]) => id === name);
    assert.ok(match, "Missing NSIS definition: " + name);
    return match[2];
  };
  const vars = {
    PRODUCTNAME: config.productName,
    MANUFACTURER: config.bundle.publisher ?? config.identifier.split(".")[1],
  };
  const expand = value => value.replace(/\x24\{(\w+)\}/g, (_, name) => vars[name] ?? expand(nsisValue(name)));
  assert.equal(nsisValue("PRODUCTNAME"), "{{product_name}}");
  assert.equal(nsisValue("MANUFACTURER"), "{{manufacturer}}");
  const paths = probePowerShell(String.raw`
. (Join-Path $root 'scripts/installer-safety.ps1')
$config = Get-Content -Raw (Join-Path $root 'src-tauri/tauri.conf.json') | ConvertFrom-Json
Get-VoxelightInstallerRegistryPaths $config.productName | ConvertTo-Json -Compress
`);
  assert.equal(paths.UninstallKey, expand(nsisValue("UNINSTKEY")));
  assert.deepEqual(paths.VendorKeys, [
    expand(nsisValue("MANUPRODUCTKEY")),
    'Software\\' + config.productName + '\\' + config.productName,
  ]);
});

test("H09 reads existing and absent paths through the native read-only registry scanner", windowsOnly, () => {
  const result = probePowerShell(String.raw`
. (Join-Path $root 'scripts/installer-safety.ps1')
$missing = 'SOFTWARE\Voxelight-No-Registry-Fixture-' + [Guid]::NewGuid()
# Built-in Windows keys used as read-only fixtures. No installer keys are queried.
$userKey = 'Control Panel\Desktop'
$keyOnly = 'HARDWARE\DESCRIPTION\System'
$withDefault = 'SOFTWARE\Classes\.exe'
$r = @{
  existingUserKey = @(Get-VoxelightInstallRegistration 'Voxelight read-only fixture' -Paths @{
    UninstallKey = $userKey; VendorKeys = @($missing)
  })
  existingKey = @(Get-VoxelightInstallRegistration 'Voxelight read-only fixture' -Paths @{
    UninstallKey = $keyOnly; VendorKeys = @($missing)
  })
  existingDefault = @(Get-VoxelightInstallRegistration 'Voxelight read-only fixture' -Paths @{
    UninstallKey = $missing; VendorKeys = @($missing, $withDefault)
  })
  missingDefault = @(Get-VoxelightInstallRegistration 'Voxelight read-only fixture' -Paths @{
    UninstallKey = $missing; VendorKeys = @($keyOnly)
  })
  absent = @(Get-VoxelightInstallRegistration 'Voxelight read-only fixture' -Paths @{
    UninstallKey = $missing; VendorKeys = @($missing)
  })
}
$r | ConvertTo-Json -Compress
`);
  assert.match(result.existingUserKey.join(","), /^CurrentUser\/(?:Registry64|Registry32|Default)\/Control Panel\\Desktop$/i);
  assert.match(result.existingKey.join(","), /^LocalMachine\/(?:Registry64|Registry32|Default)\/HARDWARE\\DESCRIPTION\\System$/i);
  assert.match(result.existingDefault.join(","), /^(?:CurrentUser|LocalMachine)\/(?:Registry64|Registry32|Default)\/SOFTWARE\\Classes\\\.exe$/i);
  assert.deepEqual(result.missingDefault, []);
  assert.deepEqual(result.absent, []);
});

test("M13 signing only the receipt targets uses certificate selection and no password", windowsOnly, () => {
  const result = probePowerShell(String.raw`
$desktop = Read-ScriptAst 'scripts/desktop.ps1'
Invoke-Expression (Add-FunctionText $desktop 'Invoke-SignArtifacts')
function Get-SignTool {
  return { $script:signCalls += ,@($args); $global:LASTEXITCODE=0 }
}
function node.exe {
  $global:LASTEXITCODE = 0
  if ($args[-2] -ne 'read' -or $args[-1] -ne $script:fixtureReceipt) { throw 'Unexpected separate artifact discovery' }
  return (ConvertTo-Json -InputObject @($script:fixtureExe) -Compress)
}
$script:fixtureTarget = Join-Path $work 'target'
$script:profile = Join-Path $script:fixtureTarget 'release'
$bundle = Join-Path $script:profile 'bundle/nsis'
$null = New-Item -ItemType Directory -Path $bundle -Force
$exe = Join-Path $script:profile 'voxelight-launcher.exe'
$stale = Join-Path $bundle 'old-cache-setup.exe'
[IO.File]::WriteAllText($exe,'current build fixture')
[IO.File]::WriteAllText($stale,'old unsigned fixture')
$script:signCalls=@()
$taskRoot=$work
$script:fixtureExe=$exe
$script:fixtureReceipt=Join-Path $work 'signing-receipt.json'
$SigningReceipt=$script:fixtureReceipt
$CertificatePassword=ConvertTo-SecureString 'SYNTHETIC-NOT-A-CREDENTIAL' -AsPlainText -Force
$CertificateThumbprint='0123456789abcd0123456789abcd0123456789abcd'
$CertificateThumbprint=$CertificateThumbprint.Substring(0,40)
$null=Invoke-SignArtifacts 6>$null
$argv=$script:signCalls[0]
@{ invocation=($argv.Count -gt 0); password=($argv -contains 'SYNTHETIC-NOT-A-CREDENTIAL' -or $argv -contains '/p'); oldCache=($argv -contains $stale); eligible=($argv -contains $exe); store=($argv -contains 'My' -and $argv -contains $CertificateThumbprint) } | ConvertTo-Json -Compress
`);
  assert.ok(result.invocation, "the synthetic signer should observe an attempted operation");
  assert.deepEqual(result, { invocation: true, password: false, oldCache: false, eligible: true, store: true });
});

test("M13 a fresh signing receipt excludes sibling cached outputs and refuses changed bytes", async () => {
  const { createSigningReceipt, readSigningReceipt } = await import("../../scripts/signing-receipt.mjs");
  const target = mkdtempSync(join(tmpdir(), "voxelight-signing-receipt-"));
  try {
    const fresh = join(target, "signing-builds", "abcdef012345abcd");
    const direct = join(fresh, "release");
    const stale = join(target, "release");
    mkdirSync(direct, { recursive: true });
    mkdirSync(stale);
    const launcher = join(direct, "voxelight-launcher.exe");
    writeFileSync(launcher, "new bytes");
    writeFileSync(join(stale, "voxelight-launcher.exe"), "cache");
    await assert.rejects(createSigningReceipt(target, fresh), /did not produce every requested/);
    const receipt = await createSigningReceipt(target, fresh, true);
    assert.deepEqual(await readSigningReceipt(target, receipt), [launcher]);
    writeFileSync(launcher, "new value"); // same size; must be checked by hash
    await assert.rejects(readSigningReceipt(target, receipt), /artifact changed/i);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("M15 -CloseRunning cannot choose a same-named process from a different directory", windowsOnly, () => {
  const result = probePowerShell(String.raw`
. (Join-Path $root 'scripts/build-process-safety.ps1')
$script:closed=@()
$script:killed=@()
$script:candidates=@()
function New-SyntheticProcess([int]$ProcessId, [string]$Path) {
 $value=[PSCustomObject]@{ Id=$ProcessId; Path=$Path; ProcessName='voxelight-launcher' }
 $value | Add-Member ScriptMethod -Name CloseMainWindow -Value { $script:closed += $this.Id; return $true }
 $value | Add-Member ScriptMethod -Name WaitForExit -Value { param($timeout) return $true }
 $value | Add-Member ScriptMethod -Name Kill -Value { $script:killed += $this.Id }
 return $value
}
function Get-Process { param([string]$Name) return $script:candidates }
function Write-Step($Text) {}
function Write-Detail($Text) {}
function Write-Fail($Text) { throw $Text }
$targetDir=Join-Path $work 'target'
$exePaths=@((Join-Path $targetDir 'release/voxelight-launcher.exe'))
$CloseRunning=$true
$CloseRunningPath=$exePaths[0]
$script:candidates=@(
  (New-SyntheticProcess 18 $exePaths[0]),
  (New-SyntheticProcess 27 (Join-Path $work 'other-copy/voxelight-launcher.exe')),
  (New-SyntheticProcess 31 $null)
)
$missing = $null
try { Stop-SelectedBuildLauncher -ExePaths $exePaths -CloseRunning } catch { $missing = $_.Exception.Message }
$didNotStopWithoutPath=$script:closed.Count -eq 0
Stop-SelectedBuildLauncher -ExePaths $exePaths -CloseRunning -CloseRunningPath $CloseRunningPath
@{closed=@($script:closed);killed=@($script:killed);exactPathNeeded=($missing.Contains($exePaths[0]) -and $didNotStopWithoutPath)} | ConvertTo-Json -Compress
`);
  assert.deepEqual(result, { closed: [18], killed: [], exactPathNeeded: true });
});

test("M15 selecting one blocked output cannot stop it while another exact output blocks the build", windowsOnly, () => {
  const result = probePowerShell(String.raw`
. (Join-Path $root 'scripts/build-process-safety.ps1')
$hostExe=Join-Path $work 'release/voxelight-launcher.exe'
$otherExe=Join-Path $work 'x86_64-pc-windows-msvc/release/voxelight-launcher.exe'
$script:closed=@()
function New-SyntheticProcess([int]$ProcessId, [string]$Path) {
 $value=[PSCustomObject]@{ Id=$ProcessId; Path=$Path }
 $value | Add-Member ScriptMethod -Name CloseMainWindow -Value { $script:closed += $this.Id; return $true }
 $value | Add-Member ScriptMethod -Name WaitForExit -Value { param($timeout) return $true }
 return $value
}
$script:candidates=@((New-SyntheticProcess 5 $hostExe),(New-SyntheticProcess 6 $otherExe))
function Get-Process { param([string]$Name) return $script:candidates }
function Write-Step($Text) {}
$message=$null
try { Stop-SelectedBuildLauncher -ExePaths @($hostExe,$otherExe) -CloseRunning -CloseRunningPath $hostExe } catch { $message=$_.Exception.Message }
@{closed=@($script:closed); listsBoth=($message.Contains($hostExe) -and $message.Contains($otherExe))} | ConvertTo-Json -Compress
`);
  assert.deepEqual(result, { closed: [], listsBoth: true });
});
