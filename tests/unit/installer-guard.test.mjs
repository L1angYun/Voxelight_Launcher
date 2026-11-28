// SPDX-License-Identifier: GPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const guard = join(root, "scripts", "check-installer.mjs");
const installerFiles = ["installer.nsi", "VoxelightPages.nsh", "README.md"];
const installerAssets = [
  "sidebar.bmp",
  "header.bmp",
  "scene.bmp",
  "installer.ico",
  "uninstaller.ico",
];

function makeFixture() {
  const fixture = mkdtempSync(join(tmpdir(), "voxelight-installer-guard-"));
  const installerRoot = join(fixture, "src-tauri", "installer", "windows");
  mkdirSync(join(installerRoot, "languages"), { recursive: true });
  mkdirSync(join(installerRoot, "assets"), { recursive: true });
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  cpSync(join(root, "src-tauri", "tauri.conf.json"), join(fixture, "src-tauri", "tauri.conf.json"));
  for (const file of installerFiles) {
    cpSync(join(root, "src-tauri", "installer", "windows", file), join(installerRoot, file));
  }
  for (const language of ["English", "SimpChinese"]) {
    cpSync(
      join(root, "src-tauri", "installer", "windows", "languages", `${language}.nsh`),
      join(installerRoot, "languages", `${language}.nsh`),
    );
  }
  for (const asset of installerAssets) {
    cpSync(
      join(root, "src-tauri", "installer", "windows", "assets", asset),
      join(installerRoot, "assets", asset),
    );
  }
  writeFileSync(join(fixture, "scripts", "generate-installer-assets.py"), "");
  for (const script of ["smoke-install.mjs", "verify-installer-ui.ps1", "build.ps1"]) {
    cpSync(join(root, "scripts", script), join(fixture, "scripts", script));
  }
  const setupFiles = [
    "index.html",
    "src/App.tsx",
    "src/setupApi.ts",
    "src-tauri/Cargo.toml",
    "src-tauri/tauri.conf.json",
    "src-tauri/app.manifest",
    "src-tauri/build.rs",
    "src-tauri/capabilities/default.json",
    "src-tauri/permissions/setup.toml",
    "src-tauri/src/main.rs",
    "src-tauri/src/lib.rs",
    "src-tauri/src/install_runner.rs",
    "src-tauri/src/path_check.rs",
    "src-tauri/src/args.rs",
    "src-tauri/src/payload.rs",
    "src-tauri/src/webview2.rs",
    "src-tauri/src/process_scan.rs",
    "src-tauri/src/webview_profile.rs",
  ];
  for (const relative of setupFiles) {
    const dest = join(fixture, "setup", relative);
    mkdirSync(join(dest, ".."), { recursive: true });
    cpSync(join(root, "setup", relative), dest);
  }
  return fixture;
}

function check(fixture) {
  // The Windows sandbox blocks piped child stdio; capture through a file.
  const log = join(fixture, "check-installer.log");
  const descriptor = openSync(log, "w");
  try {
    const result = spawnSync(process.execPath, [guard, "--root", fixture], {
      stdio: ["ignore", descriptor, descriptor],
      windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    return { status: result.status, output: readFileSync(log, "utf8") };
  } finally {
    closeSync(descriptor);
  }
}

function mutate(fixture, relative, transform) {
  const file = join(fixture, relative);
  // A Windows checkout may carry CRLF line endings.
  writeFileSync(file, transform(readFileSync(file, "utf8").replace(/\r\n/g, "\n")));
}

function withFixture(run) {
  const fixture = makeFixture();
  try {
    return run(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const installer = "src-tauri/installer/windows/installer.nsi";
const pages = "src-tauri/installer/windows/VoxelightPages.nsh";

test("installer guard accepts the checked-in template", () => {
  withFixture((fixture) => {
    const result = check(fixture);
    assert.equal(result.status, 0, result.output);
  });
});

test("installer guard rejects an unguarded remembered install folder", () => {
  withFixture((fixture) => {
    mutate(fixture, installer, (source) => {
      const start = source.indexOf("Function RestorePreviousInstallLocation");
      assert.ok(start >= 0);
      const end = source.indexOf("FunctionEnd", start);
      assert.ok(end > start);
      return `${source.slice(0, start)}Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "\${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd${source.slice(end + "FunctionEnd".length)}`;
    });
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /remembered install folder|launcher executable|executable check/i);
  });
});

test("installer guard rejects a built-in page without its UI font", () => {
  withFixture((fixture) => {
    mutate(fixture, installer, (source) =>
      source.replace('SetFont /LANG=${LANG_ENGLISH} "Segoe UI" 9\n', ""));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /Segoe UI|UI font/i);
  });
});

test("installer guard rejects a custom page without a font", () => {
  withFixture((fixture) => {
    mutate(fixture, installer, (source) =>
      source.replace("    Call VoxelightApplyDialogFonts\n    ${NSD_SetFocus} $R2", "    ${NSD_SetFocus} $R2"));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /PageReinstall.*font|font.*PageReinstall/i);
  });
});

test("installer guard rejects the NSIS branding line", () => {
  withFixture((fixture) => {
    mutate(fixture, installer, (source) =>
      source.replace('BrandingText "Voxelight Launcher"', 'BrandingText "${COPYRIGHT}"'));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /branding/i);
  });
});

test("installer guard rejects smoke cleanup that does not remove the target", () => {
  withFixture((fixture) => {
    mutate(fixture, "scripts/smoke-install.mjs", (source) =>
      source.replace("    await removeSmokeTarget();\n", ""));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /temporary target folder/i);
  });
});

test("installer guard rejects UI verification that does not delete a missing remembered key", () => {
  withFixture((fixture) => {
    mutate(fixture, "scripts/verify-installer-ui.ps1", (source) =>
      source.replace(
        "[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($installerRegistryPath, $false)",
        "",
      ));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /remembered install key it did not find/i);
  });
});

test("installer guard rejects Setup when passthrough, WebView2 fallback, minimal capabilities, or no-network rules break", () => {
  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/src/main.rs", (source) =>
      source.replace("StartupAction::Passthrough", "StartupAction::Disabled"));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /passthrough/i);
  });

  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/src/main.rs", (source) =>
      source.replace("StartupAction::WebView2Fallback", "StartupAction::NoFallback"));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /WebView2/i);
  });

  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/capabilities/default.json", (source) =>
      source.replace('"setup-commands"', '"setup-commands", "opener:allow-open-url"'));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /minimal|capability/i);
  });

  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/Cargo.toml", (source) =>
      `${source}\nreqwest = "0.12"\n`);
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /network|reqwest/i);
  });

  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/tauri.conf.json", (source) =>
      source.replace("connect-src ipc: http://ipc.localhost;", "connect-src ipc: http://ipc.localhost https://example.invalid;"));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /CSP|HTTP\/HTTPS|connect-src/i);
  });
});

test("installer guard rejects Setup without loader hardening, window fallback, or the running-launcher guard", () => {
  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/build.rs", (source) =>
      source.replaceAll("/DEPENDENTLOADFLAG:0x800", ""));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /DEPENDENTLOADFLAG/);
  });

  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/src/main.rs", (source) =>
      source.replaceAll("SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)", "let _ = 0"));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /SetDefaultDllDirectories/);
  });

  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/src/lib.rs", (source) =>
      source.replaceAll("app.run_return(", "app.run("));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /run_return|fallback/i);
  });

  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/src/install_runner.rs", (source) =>
      source.replaceAll("ensure_launcher_closed", "removed_launcher_check"));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /running|launcherRunning/i);
  });

  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/src/path_check.rs", (source) =>
      source.replaceAll("GetFinalPathNameByHandleW", "GetFinalPathNameByHandleA"));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /real path/i);
  });

  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/src/payload.rs", (source) =>
      source.replaceAll("should_show_startup_error", "show_startup_error"));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /startup error dialog|\/S/i);
  });

  withFixture((fixture) => {
    mutate(fixture, "scripts/build.ps1", (source) =>
      source.replaceAll("--fresh-nsis", "--any-nsis"));
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /written by this build/i);
  });
});

test("installer guard rejects a release Setup built without its embedded UI", () => {
  withFixture((fixture) => {
    mutate(fixture, "scripts/build.ps1", (source) => {
      assert.ok(source.includes("'--features', 'custom-protocol', "));
      return source.replace("'--features', 'custom-protocol', ", "");
    });
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /build\.ps1 must build the release Voxelight Setup with --features custom-protocol/);
  });

  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/Cargo.toml", (source) => {
      assert.ok(source.includes('custom-protocol = ["tauri/custom-protocol"]'));
      return source.replace('custom-protocol = ["tauri/custom-protocol"]', "custom-protocol = []");
    });
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /custom-protocol feature to tauri\/custom-protocol/);
  });

  withFixture((fixture) => {
    mutate(fixture, "setup/src-tauri/build.rs", (source) => {
      assert.ok(source.includes("    require_custom_protocol_for_release();\n"));
      return source.replace("    require_custom_protocol_for_release();\n", "");
    });
    const result = check(fixture);
    assert.equal(result.status, 1);
    assert.match(result.output, /refuse a release build without the custom-protocol feature/);
  });
});
