// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const config = JSON.parse(
  await readFile(path.join(project, "src-tauri/tauri.conf.json"), "utf8"),
);
const work = path.join(
  project,
  "src-tauri",
  "target",
  `install-${randomUUID()}`,
);
const local = process.env.LOCALAPPDATA;
assert(local, "LOCALAPPDATA is required for a current-user installation test");
const target = path.join(
  local,
  "Temp",
  `VoxelightLauncherSmoke-${randomUUID()}`,
);
const installer =
  process.env.SMOKE_INSTALLER ||
  path.join(
    project,
    "src-tauri",
    "target",
    "release",
    "bundle",
    "nsis",
    `Voxelight Launcher_${config.version}_x64-setup.exe`,
  );
const executable = path.join(target, "voxelight-launcher.exe");
const report = {
  product: config.productName,
  version: config.version,
  scope:
    "Isolated current-user NSIS install, license resources, registration, executable integrity and uninstall",
  installer,
  target,
  checks: [],
};
const environment = {
  ...process.env,
  VOXELIGHT_LAUNCHER_DATA_DIR: path.join(work, "data"),
  VOXELIGHT_LAUNCHER_GAME_DIR: path.join(work, "game"),
};

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function run(file, args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: work,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (bytes) => {
      output = `${output}${bytes}`.slice(-65536);
    });
    child.stderr.on("data", (bytes) => {
      output = `${output}${bytes}`.slice(-65536);
    });
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out: ${file}`));
    }, timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${file} exited with ${code}: ${output}`));
    });
  });
}

async function eventually(predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the uninstall worker");
}

function powershell(command, env = environment) {
  const systemRoot = env.SystemRoot || env.windir;
  assert(systemRoot, "SystemRoot is required for Windows PowerShell");
  const systemModules = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  const normalizedSystemModules = path.resolve(systemModules).toLowerCase();
  const inheritedModules = (env.PSModulePath || "")
    .split(path.delimiter)
    .filter(
      (entry) =>
        entry &&
        path.resolve(entry).toLowerCase() !== normalizedSystemModules,
    );
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    {
      encoding: "utf8",
      // Node can inherit PowerShell 7 modules ahead of the Windows PowerShell
      // 5.1 Security module. Prefer the compatible built-in module directory.
      env: {
        ...env,
        PSModulePath: [systemModules, ...inheritedModules].join(
          path.delimiter,
        ),
      },
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function names(directory) {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function fingerprintTree(directory) {
  const result = {};
  async function visit(current, relative = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(child, childRelative);
      else {
        result[childRelative] = createHash("sha256")
          .update(await readFile(child))
          .digest("hex");
      }
    }
  }
  if (await exists(directory)) await visit(directory);
  return result;
}

async function shortcutState() {
  const result = {};
  for (const [name, folder] of [
    ["desktop", "Desktop"],
    ["startMenu", "Programs"],
  ]) {
    const directory = powershell(
      `[Environment]::GetFolderPath('${folder}')`,
    );
    const link = path.join(directory, "Voxelight Launcher.lnk");
    result[name] = (await exists(link))
      ? createHash("sha256").update(await readFile(link)).digest("hex")
      : null;
  }
  return result;
}

async function inspectFiles(directory) {
  const result = [];
  const queue = [directory];
  while (queue.length) {
    const current = queue.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      assert(
        !entry.isSymbolicLink(),
        `Unexpected installation link: ${entry.name}`,
      );
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(file);
      else {
        assert(
          !/^(?:Steve|Alex|lumen|face)\.png$/i.test(entry.name),
          `Proprietary or removed character texture bundled: ${file}`,
        );
        assert.notEqual(entry.name, "background-beams.tsx");
        result.push(file);
      }
    }
  }
  return result;
}

try {
  await mkdir(work, { recursive: true });
  const isolatedData = environment.VOXELIGHT_LAUNCHER_DATA_DIR;
  const isolatedGame = environment.VOXELIGHT_LAUNCHER_GAME_DIR;
  await mkdir(isolatedData, { recursive: true });
  await mkdir(isolatedGame, { recursive: true });
  await writeFile(
    path.join(isolatedData, "owned-state-fixture.json"),
    JSON.stringify({ owner: "installer-smoke", preserve: true }),
  );
  await writeFile(
    path.join(isolatedGame, "owned-game-fixture.txt"),
    "preserve isolated game data",
  );
  const isolatedDataBefore = await fingerprintTree(isolatedData);
  const isolatedGameBefore = await fingerprintTree(isolatedGame);
  const dataDirectory = path.join(local, "dev.voxelight.launcher");
  const dataNamesBefore = await names(dataDirectory);
  const shortcutsBefore = await shortcutState();
  const installerBytes = await readFile(installer);
  report.setupSha256 = createHash("sha256")
    .update(installerBytes)
    .digest("hex");
  const installerIntegrity = spawnSync("icacls.exe", [installer], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    installerIntegrity.status,
    0,
    installerIntegrity.stderr || installerIntegrity.stdout,
  );
  if (/Low Mandatory Level/i.test(installerIntegrity.stdout)) {
    throw new Error(
      "The setup has a Low mandatory label. Copy the generated setup to a normal per-user directory and set SMOKE_INSTALLER to that copy; do not change ACLs or integrity labels.",
    );
  }
  const installArguments = ["/S", "/NS", `/D=${target}`];
  await run(installer, installArguments);
  await eventually(async () => exists(executable));
  const installedVersion = powershell(
    "(Get-Item -LiteralPath $env:VOXELIGHT_SIGNATURE_TARGET).VersionInfo.FileVersion",
    {
      ...environment,
      VOXELIGHT_SIGNATURE_TARGET: executable,
    },
  );
  assert.equal(
    installedVersion,
    config.version,
    "The installed executable is not the version being tested",
  );
  report.checks.push(
    "current-user silent install completed with the expected executable version",
  );
  const bytes = await readFile(executable);
  const integrity = powershell(
    "(Get-Item -LiteralPath $env:VOXELIGHT_SIGNATURE_TARGET).FullName; (Get-AuthenticodeSignature -LiteralPath $env:VOXELIGHT_SIGNATURE_TARGET).Status; (Get-Item -LiteralPath $env:VOXELIGHT_SIGNATURE_TARGET).Path",
    {
      ...environment,
      VOXELIGHT_SIGNATURE_TARGET: executable,
    },
  );
  const acl = spawnSync("icacls.exe", [executable], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(acl.status, 0, acl.stderr || acl.stdout);
  assert(
    !/Low Mandatory Level/i.test(acl.stdout),
    "Installed executable inherited a Low mandatory label",
  );
  report.program = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    lowMandatoryLabel: false,
    signatureStatus: powershell(
      "(Get-AuthenticodeSignature -LiteralPath $env:VOXELIGHT_SIGNATURE_TARGET).Status",
      {
        ...environment,
        VOXELIGHT_SIGNATURE_TARGET: executable,
      },
    ),
  };
  assert(integrity.includes(executable));
  const registration = JSON.parse(
    powershell(
      "$entry = Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -eq 'Voxelight Launcher' } | Select-Object -First 1; if ($entry) { @{ displayName = $entry.DisplayName; displayVersion = $entry.DisplayVersion } | ConvertTo-Json -Compress }",
    ),
  );
  assert.equal(registration.displayName, config.productName);
  assert.equal(registration.displayVersion, config.version);
  report.registration = registration;
  report.checks.push(
    "registered executable, version and normal integrity label",
  );

  for (const relative of [
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "dependency-inventory.json",
    "MagicUI-MIT.txt",
  ]) {
    assert(
      await exists(path.join(target, "licenses", relative)),
      `Missing installed license: ${relative}`,
    );
  }
  for (const relative of ["npm", "cargo", "toolchain"]) {
    assert(
      (await stat(path.join(target, "licenses", relative))).isDirectory(),
      `Missing installed ${relative} notices`,
    );
  }
  assert.match(
    await readFile(path.join(target, "licenses", "LICENSE"), "utf8"),
    /Version 3, 29 June 2007/,
  );
  for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    assert.deepEqual(
      await readFile(path.join(target, "licenses", name)),
      await readFile(path.join(project, name)),
      `Stale installed notice: ${name}`,
    );
  }
  const inventoryBytes = await readFile(
    path.join(project, "licenses", "dependency-inventory.json"),
  );
  assert.deepEqual(
    await readFile(path.join(target, "licenses", "dependency-inventory.json")),
    inventoryBytes,
    "Installed dependency inventory is stale",
  );
  const inventory = JSON.parse(inventoryBytes.toString("utf8"));
  const notices = new Set(inventory.packages.flatMap((entry) => entry.notices));
  notices.add("licenses/MagicUI-MIT.txt");
  for (const relative of notices) {
    assert(
      relative.startsWith("licenses/") && !relative.split("/").includes(".."),
      `Unsafe notice path: ${relative}`,
    );
    assert.deepEqual(
      await readFile(path.join(target, relative)),
      await readFile(path.join(project, relative)),
      `Installed notice differs: ${relative}`,
    );
  }
  report.verifiedNoticeFiles = notices.size;
  const installedFiles = await inspectFiles(target);
  report.installedFiles = installedFiles.length;
  report.licenseResourcesVerified = true;
  report.checks.push(
    "installed GPL and third-party notices; no excluded texture or UI source",
  );

  await writeFile(
    path.join(target, "owned-install-fixture.txt"),
    "preserve this test-owned file",
  );
  await run(installer, installArguments);
  assert.equal(
    await readFile(path.join(target, "owned-install-fixture.txt"), "utf8"),
    "preserve this test-owned file",
    "Same-version reinstall replaced the owned install fixture",
  );
  assert.deepEqual(
    await fingerprintTree(isolatedData),
    isolatedDataBefore,
    "Same-version reinstall changed isolated launcher data",
  );
  assert.deepEqual(
    await fingerprintTree(isolatedGame),
    isolatedGameBefore,
    "Same-version reinstall changed isolated game data",
  );
  report.reinstall = {
    sameVersionCompleted: true,
    ownedInstallFixturePreserved: true,
    isolatedDataPreserved: true,
  };

  await run(installer, ["/S", "/UPDATE", "/NS", `/D=${target}`]);
  assert.equal(
    await readFile(path.join(target, "owned-install-fixture.txt"), "utf8"),
    "preserve this test-owned file",
    "Update-mode reinstall replaced the owned install fixture",
  );
  assert.deepEqual(await fingerprintTree(isolatedData), isolatedDataBefore);
  assert.deepEqual(await fingerprintTree(isolatedGame), isolatedGameBefore);
  const dataNamesAfterReinstall = await names(dataDirectory);
  assert.deepEqual(
    dataNamesAfterReinstall,
    dataNamesBefore,
    "The real launcher data directory changed during repeated installation",
  );
  assert.deepEqual(
    await shortcutState(),
    shortcutsBefore,
    "Repeated installation changed desktop or Start menu shortcuts despite /NS",
  );
  report.updateModeReinstall = {
    completed: true,
    ownedInstallFixturePreserved: true,
    isolatedDataPreserved: true,
    realDataDirectoryNamesPreserved: true,
  };
  report.checks.push(
    "same-version and /UPDATE reinstalls preserved owned and isolated fixtures; /NS prevented shell shortcut changes",
  );

  powershell(
    "$processes = @(Get-Process voxelight-launcher -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:VOXELIGHT_SIGNATURE_TARGET }); if ($processes.Count -gt 0) { $processes | Stop-Process -Force -ErrorAction Stop }",
    {
      ...environment,
      VOXELIGHT_SIGNATURE_TARGET: executable,
    },
  );
  await run(path.join(target, "uninstall.exe"), ["/S"]);
  await eventually(async () => !(await exists(executable)));
  assert.equal(
    await readFile(path.join(target, "owned-install-fixture.txt"), "utf8"),
    "preserve this test-owned file",
  );
  const dataNamesAfter = await names(dataDirectory);
  assert.deepEqual(
    dataNamesAfter,
    dataNamesBefore,
    "The real launcher data directory changed during the isolated install test",
  );
  assert.deepEqual(
    await fingerprintTree(isolatedData),
    isolatedDataBefore,
    "Uninstall changed isolated launcher data",
  );
  assert.deepEqual(
    await fingerprintTree(isolatedGame),
    isolatedGameBefore,
    "Uninstall changed isolated game data",
  );
  assert.deepEqual(
    await shortcutState(),
    shortcutsBefore,
    "Uninstall changed desktop or Start menu shortcuts despite /NS",
  );
  report.uninstall = {
    programRemoved: true,
    ownedInstallFixturePreserved: true,
    realDataDirectoryNamesPreserved: true,
    isolatedDataPreserved: true,
    isolatedGameDataPreserved: true,
    shortcutsPreserved: true,
    dataDirectoryContentsRead: false,
    testDataOverridesUsed: true,
  };
  report.checks.push(
    "asynchronous uninstall completed; owned fixture and real data directory preserved",
  );
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const destination =
    process.env.SMOKE_REPORT || path.join(work, "report.json");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
