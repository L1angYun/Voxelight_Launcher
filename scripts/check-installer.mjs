import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const verify = fs.readFileSync(path.join(root, "scripts", "verify-installer-ui.ps1"), "utf8");
for (const token of ["English", "SimpChinese", "Cancel", "keyboard", "screenshot", "protected", "UIAutomationClient"]) {
  assert(verify.includes(token), `Installer UI verification lacks ${token}`);
}

console.log("Installer source checks passed: five pages, bilingual text, real progress, currentUser, accessible controls, data retention, assets and verification scripts.");
