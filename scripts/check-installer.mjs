import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootArgument = process.argv.indexOf("--root");
const root = rootArgument >= 0
  ? path.resolve(process.argv[rootArgument + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installerRoot = path.join(root, "src-tauri", "installer", "windows");
const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const nsis = config.bundle.windows.nsis;
const requiredFiles = [
  "installer.nsi",
  "VoxelightPages.nsh",
  "README.md",
  "languages/English.nsh",
  "languages/SimpChinese.nsh",
  "assets/sidebar.bmp",
  "assets/header.bmp",
  "assets/scene.bmp",
  "assets/installer.ico",
  "assets/uninstaller.ico",
];
for (const relative of requiredFiles) {
  assert(fs.existsSync(path.join(installerRoot, relative)), `Missing custom installer file: ${relative}`);
}
for (const script of ["generate-installer-assets.py", "verify-installer-ui.ps1"]) {
  assert(fs.existsSync(path.join(root, "scripts", script)), `Missing installer verification script: ${script}`);
}

assert.equal(nsis.installMode, "currentUser", "NSIS must remain current-user");
assert.equal(nsis.template, "installer/windows/installer.nsi");
assert.equal(nsis.installerHooks, "installer/windows/VoxelightPages.nsh");
assert.deepEqual(nsis.languages, ["English", "SimpChinese"]);
assert.equal(nsis.displayLanguageSelector, true);
assert.deepEqual(nsis.customLanguageFiles, {
  English: "installer/windows/languages/English.nsh",
  SimpChinese: "installer/windows/languages/SimpChinese.nsh",
});
assert.equal(nsis.sidebarImage, "installer/windows/assets/sidebar.bmp");
assert.equal(nsis.headerImage, "installer/windows/assets/header.bmp");
assert.equal(nsis.installerIcon, "installer/windows/assets/installer.ico");
assert.equal(nsis.uninstallerIcon, "installer/windows/assets/uninstaller.ico");
assert.equal(nsis.uninstallerHeaderImage, "installer/windows/assets/header.bmp");

const template = fs.readFileSync(path.join(installerRoot, "installer.nsi"), "utf8");
const customPages = fs.readFileSync(path.join(installerRoot, "VoxelightPages.nsh"), "utf8");
for (const variable of [
  "compression",
  "manufacturer",
  "product_name",
  "version",
  "version_with_build",
  "homepage",
  "install_mode",
  "license",
  "installer_icon",
  "sidebar_image",
  "header_image",
  "uninstaller_icon",
  "uninstaller_header_image",
  "main_binary_name",
  "main_binary_path",
  "bundle_id",
  "copyright",
  "out_file",
  "arch",
  "additional_plugins_path",
  "allow_downgrades",
  "display_language_selector",
  "install_webview2_mode",
  "webview2_installer_args",
  "webview2_bootstrapper_path",
  "webview2_installer_path",
  "minimum_webview2_version",
  "uninstaller_sign_cmd",
  "estimated_size",
  "start_menu_folder",
]) {
  assert(template.includes(`{{${variable}}}`), `Missing Tauri template variable: ${variable}`);
}
for (const token of [
  "{{#each resources}}",
  "{{#each resources_dirs}}",
  "{{#each binaries}}",
  "{{#each resources_ancestors}}",
  "{{#each languages}}",
  "{{#each language_files}}",
  "{{#if installer_hooks}}",
]) assert(template.includes(token), `Missing Tauri resource/template expansion: ${token}`);

const pageOrder = [
  "Page custom PageWelcome",
  "!insertmacro MUI_PAGE_DIRECTORY",
  "Page custom PageOptions",
  "!insertmacro MUI_PAGE_INSTFILES",
  "Page custom PageFinish",
];
let previous = -1;
for (const token of pageOrder) {
  const index = template.indexOf(token);
  assert(index > previous, `Installer page order is not welcome → location → options → install → finish: ${token}`);
  previous = index;
}
assert(!template.includes("MUI_PAGE_LICENSE"), "The custom five-page flow must not add a separate license page");
assert(template.includes("PageReinstall"), "Upgrade/reinstall choice must remain available");
assert(template.includes("RequestExecutionLevel user"), "currentUser execution level is required");
assert.match(
  template,
  /!if "\$\{INSTALLMODE\}" == "perMachine"\s+RequestExecutionLevel admin\s+!endif/,
  "The upstream admin branch must remain conditional on perMachine mode",
);
assert.match(
  template,
  /!if "\$\{INSTALLMODE\}" == "currentUser"\s+RequestExecutionLevel user\s+!endif/,
  "The active currentUser branch must explicitly request a standard user token",
);
assert.equal(
  [...template.matchAll(/RequestExecutionLevel admin/g)].length,
  1,
  "No additional administrator execution level may be introduced",
);
assert(template.includes("${GetOptions} $CMDLINE \"/P\""), "Passive /P handling must remain");
assert(template.includes("${GetOptions} $CMDLINE \"/UPDATE\""), "Upgrade /UPDATE handling must remain");
assert(
  !template.includes('!include "VoxelightPages.nsh"'),
  "The custom page include must use Tauri's absolute installerHooks path, not a target-relative sibling",
);
assert(template.includes("MUI_LANGDLL_DISPLAY"), "Language selector must remain enabled");
assert(template.includes("MUI_PAGE_INSTFILES"), "Real file-copy progress must use the native install page");
assert(template.includes("MUI_DIRECTORYPAGE_TEXT_TOP"), "Location copy must use the MUI2 directory-page macro");
assert(template.includes("DetailPrint \"$(installPreparing)\""), "Install phase must have a real start message");
assert(template.includes("DetailPrint \"$(installCompleted)\""), "Install phase must have a real completion message");
assert(!/Sleep\s+\d+|FakeProgress|SetProgress/i.test(template), "No fabricated progress is allowed");
assert(customPages.includes("NSD_SetFocus"), "Native controls must receive keyboard focus");
assert(customPages.includes("NSD_CreateCheckBox"), "Options must use native checkboxes");
assert(
  /Function CreateOrUpdateStartMenuShortcut[\s\S]*?\$\{OrIf\} \$NoShortcutMode = 1[\s\S]*?FunctionEnd/.test(template),
  "Start menu option must control only the Start menu shortcut",
);
assert(
  /Function CreateOrUpdateDesktopShortcut[\s\S]*?\$\{OrIf\} \$NoDesktopShortcutMode = 1[\s\S]*?FunctionEnd/.test(template),
  "Desktop option must control only the desktop shortcut",
);
assert(
  !template.includes("MUI_FINISHPAGE_SHOWREADME"),
  "The finish page must not repeat the desktop shortcut option",
);
assert(template.includes("${If} $DeleteAppDataCheckboxState = 1"), "Data deletion must remain an explicit opt-in");
assert(
  !/StrCpy\s+\$DeleteAppDataCheckboxState\s+1(?:\s|$)/m.test(template),
  "Delete-data must not be assigned as the default",
);

function functionSource(source, name) {
  const marker = `Function ${name}`;
  const start = source.indexOf(marker);
  assert(start >= 0, `Missing installer function: ${name}`);
  const end = source.indexOf("FunctionEnd", start + marker.length);
  assert(end > start, `Unterminated installer function: ${name}`);
  return source.slice(start, end);
}

const restorePreviousInstallLocation = functionSource(template, "RestorePreviousInstallLocation");
assert(
  restorePreviousInstallLocation.includes('ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""'),
  "RestorePreviousInstallLocation must still read the remembered install folder",
);
const rememberedExecutableCheck = '${FileExists} "$4\\${MAINBINARYNAME}.exe"';
const rememberedExecutableIndex = restorePreviousInstallLocation.indexOf(rememberedExecutableCheck);
const rememberedDirectoryCopyIndex = restorePreviousInstallLocation.indexOf("StrCpy $INSTDIR $4");
const rememberedGuardEndIndex = restorePreviousInstallLocation.indexOf(
  "${EndIf}",
  rememberedExecutableIndex,
);
assert(
  rememberedExecutableIndex >= 0,
  "RestorePreviousInstallLocation must require the launcher executable in the remembered folder",
);
assert(
  rememberedDirectoryCopyIndex > rememberedExecutableIndex &&
    rememberedDirectoryCopyIndex < rememberedGuardEndIndex,
  "The remembered install folder may only replace InstallDir inside the executable check",
);
// Every other read of the remembered folder must be followed by the same
// executable check, falling back to the chosen InstallDir when it is stale.
for (const match of template.matchAll(/ReadRegStr\s+\$4\s+SHCTX\s+"\$\{MANUPRODUCTKEY\}"\s+""/g)) {
  if (restorePreviousInstallLocation.includes(match[0]) && template.indexOf(restorePreviousInstallLocation) <= match.index
    && match.index < template.indexOf(restorePreviousInstallLocation) + restorePreviousInstallLocation.length) continue;
  const following = template.slice(match.index, match.index + 260);
  assert(
    /\$\{IfNot\}\s+\$\{FileExists\}\s+"\$4\\\$\{MAINBINARYNAME\}\.exe"\s+StrCpy\s+\$4\s+"\$INSTDIR"\s+\$\{EndIf\}/.test(following),
    "A remembered install folder read outside RestorePreviousInstallLocation must be checked for the launcher executable",
  );
}

const languageReserveIndex = template.indexOf("!insertmacro MUI_RESERVEFILE_LANGDLL");
const installerInitIndex = template.indexOf("Function .onInit");
assert(languageReserveIndex >= 0 && installerInitIndex > languageReserveIndex, "Language setup order changed");
for (const [language, font] of [
  ["LANG_ENGLISH", "Segoe UI"],
  ["LANG_SIMPCHINESE", "Microsoft YaHei UI"],
]) {
  const fontDeclaration = new RegExp(
    `^SetFont /LANG=\\$\\{${language}\\} "${font}" \\d+$`,
    "m",
  ).exec(template);
  assert(fontDeclaration, `Missing ${font} UI font for ${language} on the built-in installer pages`);
  const fontIndex = template.indexOf(fontDeclaration[0]);
  assert(
    fontIndex > languageReserveIndex && fontIndex < installerInitIndex,
    `The ${language} UI font must be set after the language files are loaded and before .onInit`,
  );
}

for (const [page, source] of [
  ["PageWelcome", customPages],
  ["PageReinstall", template],
  ["PageOptions", customPages],
  ["PageFinish", customPages],
]) {
  const body = functionSource(source, page);
  assert(
    /WM_SETFONT|\$Voxelight(?:Body|Semibold|Small|Display)Font|VoxelightApplyDialogFonts/.test(body),
    `Installer page ${page} must apply a UI font to its controls`,
  );
}
const guiInit = functionSource(customPages, "VoxelightGuiInit");
assert(
  guiInit.includes("SendMessage $mui.Header.Text ${WM_SETFONT}"),
  "The MUI header must use the Voxelight UI font",
);
assert(
  guiInit.includes("SendMessage $mui.Branding.Text ${WM_SETFONT} $VoxelightSmallFont 1"),
  "The branding line must use the small UI font",
);
assert(
  guiInit.includes('SendMessage $mui.Branding.Text ${WM_SETTEXT} 0 "STR:Voxelight Launcher"'),
  "The branding line must read Voxelight Launcher",
);
assert(
  template.includes('BrandingText "Voxelight Launcher"'),
  "The template branding text must be Voxelight Launcher, not the NSIS version line",
);
assert(
  !template.includes('BrandingText "${COPYRIGHT}"') && !template.includes("$(^Branding)"),
  "The NSIS branding text must not be kept",
);
assert(
  functionSource(customPages, "un.VoxelightUnGuiInit").includes('"STR:Voxelight Launcher"'),
  "The uninstaller branding line must read Voxelight Launcher",
);

const english = fs.readFileSync(path.join(installerRoot, "languages", "English.nsh"), "utf8");
const chinese = fs.readFileSync(path.join(installerRoot, "languages", "SimpChinese.nsh"), "utf8");
const langKeys = (source) => new Set([...source.matchAll(/^LangString\s+(\w+)\s+/gm)].map((match) => match[1]));
const englishKeys = langKeys(english);
const chineseKeys = langKeys(chinese);
for (const key of [
  "welcomeTitle",
  "welcomeDescription",
  "optionsTitle",
  "optionsDescription",
  "desktopShortcut",
  "startMenuShortcut",
  "locationDescription",
  "installPreparing",
  "installCompleted",
  "finishTitle",
  "finishDescription",
  "dataRetention",
  "createDesktop",
  "alreadyInstalled",
  "chooseHowToInstall",
  "uninstallApp",
  "deleteAppData",
]) {
  assert(englishKeys.has(key), `Missing English installer text: ${key}`);
  assert(chineseKeys.has(key), `Missing SimpChinese installer text: ${key}`);
}
assert.deepEqual(englishKeys, chineseKeys, "Installer language files must cover the same message IDs");
for (const [language, source] of [["English", english], ["SimpChinese", chinese]]) {
  for (const [id, value] of source.matchAll(/^LangString\s+(\w+)\s+.*"([^"]*)"$/gm)) {
    if (id !== "choowHowToInstall") assert(value.trim(), `${language} has an empty installer message: ${id}`);
  }
}

const bmp = (file, width, height) => {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString("ascii", 0, 2), "BM", `${path.basename(file)} is not a valid BMP`);
  assert.equal(bytes.readUInt32LE(18), width, `${path.basename(file)} has wrong width`);
  assert.equal(bytes.readUInt32LE(22), height, `${path.basename(file)} has wrong height`);
};
bmp(path.join(installerRoot, "assets", "sidebar.bmp"), 164, 314);
bmp(path.join(installerRoot, "assets", "header.bmp"), 150, 57);
for (const name of ["installer.ico", "uninstaller.ico"]) {
  const bytes = fs.readFileSync(path.join(installerRoot, "assets", name));
  assert.equal(bytes.readUInt16LE(0), 0, `${name} is not an ICO file`);
  assert.equal(bytes.readUInt16LE(2), 1, `${name} is not an ICO file`);
  assert(bytes.readUInt16LE(4) >= 4, `${name} must contain multiple icon sizes`);
}

const smoke = fs.readFileSync(path.join(root, "scripts", "smoke-install.mjs"), "utf8");
assert.match(smoke, /repeat|upgrade|reinstall/i, "Smoke test must cover repeated installation");
assert.match(smoke, /owned-install-fixture\.txt/, "Repeated installation must preserve the owned fixture");
assert.match(smoke, /dataNamesAfter/, "Real user data must be checked after install/uninstall");
assert.match(
  smoke,
  /const rememberedBefore = readRememberedInstallLocationState\(\);/,
  "Smoke test must record the remembered install location before installing",
);
assert.match(
  smoke,
  /restoreRememberedInstallLocationState\(rememberedBefore\);/,
  "Smoke test must restore the remembered install location after uninstalling",
);
assert.match(
  smoke,
  /await removeSmokeTarget\(\);/,
  "Smoke test must remove the temporary target folder",
);
assert.match(
  smoke,
  /\$key\.GetValueNames\(\)/,
  "Smoke test must record every value in the remembered install key",
);
assert.match(
  smoke,
  /\$key\.SetValue\(/,
  "Smoke test must restore the remembered install key values",
);
assert.match(
  smoke,
  /DeleteSubKeyTree/,
  "Smoke test must delete a remembered install key it did not find",
);
assert.match(
  smoke,
  /rememberedBefore\.exists/,
  "Smoke report must record whether the remembered install key existed",
);
assert.match(
  smoke,
  /rememberedLocationPointsAtTarget: false/,
  "Smoke report must state that the remembered location no longer points at the temporary target",
);
assert.match(
  smoke,
  /post-uninstall cleanup restored the remembered install location and removed the temporary target/,
  "Smoke report must include a cleanup check",
);
const verify = fs.readFileSync(path.join(root, "scripts", "verify-installer-ui.ps1"), "utf8");
for (const token of ["English", "SimpChinese", "Cancel", "keyboard", "screenshot", "protected", "UIAutomationClient"]) {
  assert(verify.includes(token), `Installer UI verification lacks ${token}`);
}
for (const [token, message] of [
  ["Get-InstallerRegistryState", "must record the remembered install key before installing"],
  ["$key.GetValueNames()", "must snapshot every remembered install key value"],
  ["$key.SetValue(", "must restore the remembered install key values"],
  ["[bool]$registryBefore.exists", "must record whether the remembered install key existed"],
  ["Get-RememberedInstallLocation", "must inspect the remembered install location after uninstalling"],
  ["DeleteSubKeyTree($installerRegistryPath", "must delete a remembered install key it did not find"],
  ["rememberedLocationPointsAtTarget", "must report whether the remembered location still points at the temporary target"],
  ["post-uninstall cleanup restored the remembered install location and removed the temporary target", "must report the cleanup result"],
]) {
  assert(verify.includes(token), `Installer UI verification ${message}`);
}

// ---------------------------------------------------------------------------
// Voxelight Setup (front-end wrapper around the silent NSIS payload)
// ---------------------------------------------------------------------------
const setupRoot = path.join(root, "setup");
const setupTauriRoot = path.join(setupRoot, "src-tauri");
const requiredSetupFiles = [
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
  "src-tauri/src/args.rs",
  "src-tauri/src/install_runner.rs",
  "src-tauri/src/path_check.rs",
  "src-tauri/src/payload.rs",
  "src-tauri/src/webview2.rs",
  "src-tauri/src/process_scan.rs",
  "src-tauri/src/webview_profile.rs",
];
for (const relative of requiredSetupFiles) {
  assert(fs.existsSync(path.join(setupRoot, relative)), `Missing Voxelight Setup file: setup/${relative}`);
}

// 1. Passthrough & payload verification checks
const setupMain = fs.readFileSync(path.join(setupTauriRoot, "src", "main.rs"), "utf8");
const setupLib = fs.readFileSync(path.join(setupTauriRoot, "src", "lib.rs"), "utf8");
const setupArgs = fs.readFileSync(path.join(setupTauriRoot, "src", "args.rs"), "utf8");
const setupPayload = fs.readFileSync(path.join(setupTauriRoot, "src", "payload.rs"), "utf8");
const setupBuildRs = fs.readFileSync(path.join(setupTauriRoot, "build.rs"), "utf8");
const setupInstallRunner = fs.readFileSync(path.join(setupTauriRoot, "src", "install_runner.rs"), "utf8");
const setupPathCheck = fs.readFileSync(path.join(setupTauriRoot, "src", "path_check.rs"), "utf8");
const setupProcessScan = fs.readFileSync(path.join(setupTauriRoot, "src", "process_scan.rs"), "utf8");
const setupWebviewProfile = fs.readFileSync(path.join(setupTauriRoot, "src", "webview_profile.rs"), "utf8");
assert(setupMain.includes("decide_startup_action"), "Voxelight Setup must decide startup mode before creating any window");
const passthroughIndex = setupMain.indexOf("StartupAction::Passthrough");
const webviewFallbackIndex = setupMain.indexOf("StartupAction::WebView2Fallback");
const launchUiIndex = setupMain.indexOf("run_ui()");
assert(
  passthroughIndex >= 0 && passthroughIndex < launchUiIndex,
  "Voxelight Setup must handle NSIS CLI passthrough before creating any window",
);
assert(
  /StartupAction::Passthrough\([^)]*\)\s*=>\s*\{[\s\S]*?run_embedded_payload\([\s\S]*?std::process::exit\(/.test(setupMain),
  "Voxelight Setup passthrough must execute the embedded payload and return its exit code",
);
assert(setupArgs.includes("pub fn should_passthrough"), "Voxelight Setup must detect NSIS CLI flags for passthrough");
assert(setupArgs.includes("raw_arg"), "Voxelight Setup must pass /D= unquoted so NSIS handles spaces");
assert(setupPayload.includes("create_dir(&candidate)"), "Voxelight Setup must create its extraction folder exclusively");
assert(setupPayload.includes("create_new(true)"), "Voxelight Setup must create its extracted payload file exclusively");
assert(
  setupPayload.includes("digest_equals") && setupPayload.includes("PAYLOAD_SHA256"),
  "Voxelight Setup must verify the payload SHA-256 against the compiled-in digest before running",
);

// 2. WebView2 fallback checks
const setupWebview2 = fs.readFileSync(path.join(setupTauriRoot, "src", "webview2.rs"), "utf8");
assert(
  webviewFallbackIndex >= 0 && webviewFallbackIndex < launchUiIndex,
  "Voxelight Setup must check WebView2 availability and fall back before creating any window",
);
assert(
  /StartupAction::WebView2Fallback\s*=>\s*\{[\s\S]*?run_embedded_payload\(&\[\]\)[\s\S]*?std::process::exit\(/.test(setupMain),
  "Voxelight Setup WebView2 fallback must launch the embedded NSIS payload with its normal UI",
);
assert(
  setupWebview2.includes("{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
  "Voxelight Setup WebView2 detection must check the official Evergreen WebView2 client GUID",
);
assert(
  setupWebview2.includes("WOW6432Node") && setupWebview2.includes("HKEY_CURRENT_USER") && setupWebview2.includes("0.0.0.0"),
  "Voxelight Setup WebView2 detection must inspect machine and user hives and reject 0.0.0.0",
);

// 3. Minimal capabilities & non-elevation checks
const setupManifest = fs.readFileSync(path.join(setupTauriRoot, "app.manifest"), "utf8");
assert(setupManifest.includes('level="asInvoker"'), "Voxelight Setup manifest must run asInvoker");
assert(
  !/requireAdministrator|highestAvailable/i.test(setupManifest),
  "Voxelight Setup manifest must never request elevation",
);

const setupCapabilities = JSON.parse(
  fs.readFileSync(path.join(setupTauriRoot, "capabilities", "default.json"), "utf8"),
);
assert.deepEqual(setupCapabilities.windows, ["setup"], "Voxelight Setup capabilities must scope only to the setup window");
const expectedSetupPermissions = [
  "core:window:allow-start-dragging",
  "core:window:allow-minimize",
  "core:window:allow-close",
  "core:event:allow-listen",
  "core:event:allow-unlisten",
  "setup-commands",
];
assert.deepEqual(
  [...setupCapabilities.permissions].sort(),
  [...expectedSetupPermissions].sort(),
  "Voxelight Setup capabilities must remain strictly minimal",
);
for (const entry of setupCapabilities.permissions) {
  assert.equal(typeof entry, "string", "Voxelight Setup capabilities must not include broad object permission scopes");
  assert(
    !/^(?:core:default|opener:|shell:|fs:|http:|dialog:)/i.test(entry),
    `Disallowed broad capability in Voxelight Setup: ${entry}`,
  );
}

const setupPermissionsToml = fs.readFileSync(path.join(setupTauriRoot, "permissions", "setup.toml"), "utf8");
const allowedCommandsMatch = setupPermissionsToml.match(/commands\.allow\s*=\s*\[([\s\S]*?)\]/);
assert(allowedCommandsMatch, "Voxelight Setup permissions must declare commands.allow");
const allowedCommands = [...allowedCommandsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
assert.deepEqual(
  allowedCommands,
  [
    "get_license_text",
    "get_setup_state",
    "launch_installed",
    "open_classic_installer",
    "pick_install_directory",
    "start_install",
    "validate_install_path",
  ],
  "Voxelight Setup command permission allowlist must stay minimal",
);

// 4. No network access, strict CSP, and no duplicated font binaries
const setupCargo = fs.readFileSync(path.join(setupTauriRoot, "Cargo.toml"), "utf8");
for (const forbiddenCrate of [
  "reqwest",
  "hyper",
  "ureq",
  "surf",
  "tauri-plugin-http",
  "tauri-plugin-opener",
  "tauri-plugin-shell",
]) {
  assert(
    !new RegExp(`^\\s*${forbiddenCrate}\\s*=`, "m").test(setupCargo),
    `Voxelight Setup must not depend on network or shell crate: ${forbiddenCrate}`,
  );
}

const setupTauriConf = JSON.parse(fs.readFileSync(path.join(setupTauriRoot, "tauri.conf.json"), "utf8"));
const setupCsp = setupTauriConf.app?.security?.csp ?? "";
assert(setupCsp.includes("default-src 'self'"), "Voxelight Setup CSP must restrict default-src to 'self'");
assert(
  setupCsp.includes("connect-src ipc: http://ipc.localhost;"),
  "Voxelight Setup CSP must restrict connect-src strictly to local Tauri IPC",
);
assert(!/https?:/i.test(setupCsp.replace("http://ipc.localhost", "")), "Voxelight Setup CSP must not allow external HTTP/HTTPS origins");
assert(setupCsp.includes("object-src 'none'") && setupCsp.includes("frame-src 'none'"), "Voxelight Setup CSP must block objects and frames");
const setupWindow = setupTauriConf.app?.windows?.[0];
assert(setupWindow && setupWindow.decorations === false && setupWindow.resizable === false, "Voxelight Setup window must be frameless and non-resizable");

function walkSetupFiles(dir, result = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["target", "gen", "node_modules"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSetupFiles(full, result);
    else result.push(full);
  }
  return result;
}
for (const file of walkSetupFiles(setupRoot)) {
  assert(!/\.(?:woff2?|ttf|otf)$/i.test(file), `Fonts must not be duplicated under setup/: ${path.relative(root, file)}`);
  if (file.startsWith(path.join(setupRoot, "src")) && /\.(?:ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file)) {
    const content = fs.readFileSync(file, "utf8");
    assert(
      !/\b(?:fetch\s*\(|XMLHttpRequest|new\s+WebSocket|new\s+EventSource)\b/.test(content),
      `Voxelight Setup UI must not make network requests: ${path.relative(root, file)}`,
    );
  }
}

// 5. DLL search hardenings (Setup can be launched from Downloads)
for (const token of [
  "/DEPENDENTLOADFLAG:0x800",
  "/DELAYLOAD:dwmapi.dll",
  "/DELAYLOAD:WINHTTP.dll",
  "/DELAYLOAD:USERENV.dll",
  "/DELAYLOAD:RstrtMgr.DLL",
  "delayimp.lib",
]) {
  assert(
    setupBuildRs.includes(token),
    `Voxelight Setup build.rs must keep the loader hardening: ${token}`,
  );
}
const mainBody = setupMain.slice(setupMain.indexOf("fn main()"));
const dllHardeningIndex = mainBody.indexOf("SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32)");
const firstArgumentIndex = mainBody.indexOf("std::env::args_os");
assert(
  dllHardeningIndex >= 0 && firstArgumentIndex > dllHardeningIndex,
  "Voxelight Setup main must call SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) before reading the command line",
);
assert(
  !/std::process::Command::new|std::fs::|tauri::Builder/.test(mainBody.slice(0, dllHardeningIndex)),
  "No DLL-loading or app startup code may run before SetDefaultDllDirectories",
);

// 6. Window failures must return control instead of panicking under panic=abort
assert(setupLib.includes("run_return("), "Voxelight Setup must use run_return so a window failure can reach the NSIS fallback");
assert(setupLib.includes("UiOutcome::WindowFailed"), "Voxelight Setup must report window creation failure to main");
assert(
  /UiOutcome::WindowFailed\(error\)\)\s*=>\s*\{[\s\S]*?fall_back_to_nsis/.test(setupMain),
  "Voxelight Setup main must run the NSIS UI after a window creation failure",
);
assert(
  setupLib.includes("app.handle().exit(0)"),
  "A failed window build must ask the event loop to exit instead of returning Err from Tauri's setup callback",
);
assert(
  setupLib.includes(".data_directory(webview_temp)"),
  "Voxelight Setup must always use its private WebView2 data folder",
);
assert(
  setupLib.includes("create_webview_profile") &&
    setupWebviewProfile.includes("WEBVIEW_PROFILE_PREFIX") &&
    setupWebviewProfile.includes("CLEANUP_ATTEMPTS"),
  "Voxelight Setup must create a private WebView2 profile and retry its cleanup",
);
assert(
  setupWebviewProfile.includes("cleanup_with_retries") &&
    setupLib.includes("cleanup_webview_profile"),
  "The temporary WebView2 profile must be removed after the webview processes exit",
);

// 7. Raw passthrough must keep the original command line and stay silent on failure
assert(
  setupArgs.includes("GetCommandLineW") && setupArgs.includes("raw_command_line_tail"),
  "Voxelight Setup must read the raw command line for passthrough",
);
assert(
  setupMain.includes("run_embedded_payload_raw") && setupPayload.includes("raw_arg"),
  "Voxelight Setup must forward the raw command-line tail with raw_arg",
);
assert(
  setupPayload.includes("should_show_startup_error") && setupPayload.includes('eq_ignore_ascii_case("/S")'),
  "Voxelight Setup must not show a startup error dialog when /S is present",
);
assert(
  setupPayload.includes("PAYLOAD_START_FAILURE_EXIT_CODE") && setupPayload.includes("PAYLOAD_START_FAILURE_EXIT_CODE: i32 = 2"),
  "Voxelight Setup must use a documented exit code distinct from NSIS user-cancelled 1",
);

// 8. A running launcher is detected before the silent payload can kill it
assert(
  setupInstallRunner.includes("launcherRunning") && setupInstallRunner.includes("ensure_launcher_closed"),
  "Voxelight Setup must refuse a silent install while the target launcher is running",
);
assert(
  setupProcessScan.includes("QueryFullProcessImageNameW") && setupProcessScan.includes("any_launcher_running"),
  "The process scan must compare real process image paths with the target launcher path",
);
assert(
  setupProcessScan.includes("MAIN_BINARY_NAME"),
  "The process scan must use the launcher executable name",
);

// 9. Path validation uses real paths and rejects shared writable roots
assert(
  setupPathCheck.includes("GetFinalPathNameByHandleW"),
  "Path validation must resolve the deepest existing folder to its real path",
);
assert(
  setupPathCheck.includes("shared_writable_roots") &&
    setupPathCheck.includes("ProgramData") &&
    setupPathCheck.includes("Users\\Public") &&
    setupPathCheck.includes("is_drive_root"),
  "Path validation must reject ProgramData, Public and drive roots",
);

// Elevated Setup must not start the launcher with its own token
assert(
  setupLib.includes("launch_available(is_process_elevated())") &&
    setupLib.includes("launchBlockedElevated"),
  "Voxelight Setup must not launch the installed app from an elevated process",
);

// 10. Temp extraction only inspects the folder it created
assert(
  !setupPayload.includes("checked_ancestors(base_temp)"),
  "Temp extraction must not reject a redirected folder above %TEMP%",
);

// 11. Release tooling: Setup marker + fresh NSIS payload only
assert(
  setupLib.includes("VOXELIGHT_SETUP_HOST_V1"),
  "Voxelight Setup must compile its release marker into the executable",
);
assert(
  setupPayload.includes("PAYLOAD_SHA256"),
  "Voxelight Setup must still verify the embedded payload hash",
);

const buildScript = fs.readFileSync(path.join(root, "scripts", "build.ps1"), "utf8");
assert(buildScript.includes("VOXELIGHT_SETUP_PAYLOAD"), "scripts/build.ps1 must embed the NSIS payload into Voxelight Setup");
assert(buildScript.includes("VoxelightLauncher-$version-x64-setup.exe"), "scripts/build.ps1 must output Voxelight Setup under the release asset name");
assert(buildScript.includes("_x64-nsis.exe"), "scripts/build.ps1 must preserve the raw NSIS installer artifact for smoke tests");
assert(
  buildScript.includes("--fresh-nsis") && buildScript.includes("$started.ToString('o')"),
  "scripts/build.ps1 must only embed an NSIS installer written by this build",
);

// 12. The release Setup embeds its UI. Without Tauri's custom-protocol feature
// the executable carries no pages and its window loads build.devUrl instead.
const setupFeatures = setupCargo.replace(/\r\n/g, "\n").match(/^\[features\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m);
assert(
  setupFeatures && /^custom-protocol\s*=\s*\[\s*"tauri\/custom-protocol"\s*\]/m.test(setupFeatures[1]),
  "Voxelight Setup Cargo.toml must map its custom-protocol feature to tauri/custom-protocol",
);
const setupCargoArgs = buildScript.match(/\$cargoArgs\s*=\s*@\(([^)]*)\)/);
assert(
  setupCargoArgs &&
    setupCargoArgs[1].includes("'--release'") &&
    setupCargoArgs[1].includes("$setupManifest") &&
    /'--features',\s*'(?:tauri\/)?custom-protocol'/.test(setupCargoArgs[1]),
  "scripts/build.ps1 must build the release Voxelight Setup with --features custom-protocol so its UI is embedded",
);
const setupBuildMain = setupBuildRs.slice(setupBuildRs.indexOf("fn main()"));
assert(
  /fn require_custom_protocol_for_release\(\)\s*\{[\s\S]*?profile == "release" && tauri_build::is_dev\(\)[\s\S]*?panic!/.test(setupBuildRs) &&
    setupBuildMain.includes("require_custom_protocol_for_release();"),
  "Voxelight Setup build.rs must refuse a release build without the custom-protocol feature",
);

console.log("Installer source checks passed: NSIS template, Voxelight Setup passthrough, WebView2 fallback, loader hardening, private WebView2 profile, running-launcher guard, path checks, minimal capabilities, no network, no duplicated fonts, an embedded release Setup UI, and build integration.");
