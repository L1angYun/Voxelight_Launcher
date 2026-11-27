import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../../scripts/check-i18n.mjs", import.meta.url));
async function checkTree(files) {
  const prefix = join(tmpdir(), "voxelight-i18n-guard-");
  const root = await mkdtemp(prefix);
  try {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), text);
    }
    const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    return { status: result.status, text: result.stdout + result.stderr };
  } finally {
    assert(resolve(root).startsWith(resolve(prefix)));
    await rm(root, { recursive: true, force: true });
  }
}
async function check(keys, code, extension = "ts") {
  const files = { "src-tauri/src/lib.rs": "", ["src/app/example." + extension]: code };
  for (const locale of ["zh-CN", "en-US"]) files[`src/i18n/locales/${locale}/library.json`] = JSON.stringify(keys);
  return checkTree(files);
}
const backendCrate = {
  "src-tauri/src/lib.rs": "mod errors;\nmod loaders;\nmod reset;\n#[cfg(test)]\n#[path = \"loader_fixtures.rs\"]\nmod loader_fixtures;\n",
  "src-tauri/src/errors.rs": "pub fn code(detail: &str) -> &'static str {\n    match detail {\n        \"busy\" => \"loader.busy\",\n        _ => \"internal.unexpected\",\n    }\n}\n",
  "src-tauri/src/loaders.rs": [
    "// \"loader.commented\" is only mentioned here.",
    "pub(crate) const OPTIFINE_INVALID: &str = \"loader.optifineInvalid\";",
    "pub fn refuse() -> AppError { AppError::new(\"loader.optifineOnlineUnavailable\") }",
    "pub fn profile() -> &'static str { \"loader.json\" }",
    "pub fn reason(large: bool) -> Option<&'static str> { if large { Some(\"loader.switchBackupTooLarge\") } else { None } }",
    "#[cfg(test)]",
    "fn fixture() -> AppError { AppError::new(\"loader.testOnly\") }",
    "",
  ].join("\n"),
  "src-tauri/src/reset/mod.rs": "mod refusals;\n",
  "src-tauri/src/reset/refusals.rs": "pub fn running() -> AppError { AppError::new(\"reset.gameRunning\") }\n",
  "src-tauri/src/loader_fixtures.rs": "fn fixture() -> AppError { AppError::new(\"loader.fixtureOnly\") }\n",
  "src/app/errors.ts": "declare const t: any; declare const code: string; t(`shell:errors.${code}`); t(`settings:errors.${code}`);",
};
function backendLocales(shellErrors, settingsErrors = {}) {
  const files = {};
  for (const locale of ["zh-CN", "en-US"]) {
    files[`src/i18n/locales/${locale}/common.json`] = JSON.stringify({ errors: { internalUnexpected: "unexpected" } });
    files[`src/i18n/locales/${locale}/shell.json`] = JSON.stringify({ errors: shellErrors });
    files[`src/i18n/locales/${locale}/settings.json`] = JSON.stringify({ errors: settingsErrors });
  }
  return files;
}
test("i18n guard finds unused keys while counting TypeScript and plural references", async () => {
  const result = await check({ used_one: "one", used_other: "many", unused: "unused" }, 'declare const t: any; t("library:used");');
  assert.equal(result.status, 1); assert.match(result.text, /Unused.*library.unused/);
  assert.doesNotMatch(result.text, /Unused.*library.used/);
});
test("i18n guard supports scoped dynamic keys and backend error families", async () => {
  const result = await check({ status: { ready: "ready", failed: "failed" }, errors: { remote: "remote" } },
    'declare const t: any; declare const state: string; t(`library:status.${state}`);');
  assert.equal(result.status, 0, result.text);
});
test("namespace-wide dynamic calls do not hide unused keys", async () => {
  const result = await check({ release: "release", snapshot: "snapshot", noInstances: "unused" },
    'declare const t: any; ["release", "snapshot"].map(value => t(`library:${value}`));');
  assert.equal(result.status, 1); assert.match(result.text, /Unused.*library.noInstances/);
  assert.doesNotMatch(result.text, /Unused.*library.(release|snapshot)/);
});
test("i18n guard detects a missing key referenced by a TypeScript utility", async () => {
  const result = await check({ used: "used" }, 'declare const t: any; t("library:used"); t("library:missing");');
  assert.equal(result.status, 1); assert.match(result.text, /Missing.*library.missing/);
});
test("concatenated scoped keys remain live without exempting unrelated translations", async () => {
  const result = await check({ notice: { saved: "saved" }, unused: "unused" },
    'declare const t: any; declare const event: string; t("library:notice." + event);');
  assert.equal(result.status, 1); assert.match(result.text, /Unused.*library.unused/);
  assert.doesNotMatch(result.text, /(?:Unused|Missing).*library.notice/);
});
test("finite registry label data does not turn a namespace into an unused-key wildcard", async () => {
  const result = await check({ instance: { tab: { overview: "overview" } }, unused: "unused" },
    'declare const t: any; declare function createRegistry(v: any): any; const instanceTabRegistry = createRegistry([{id:"overview",labelKey:"instance.tab.overview"}]); instanceTabRegistry.enabled({}).map(item => t(`library:${item.labelKey}`));');
  assert.equal(result.status, 1); assert.match(result.text, /Unused.*library.unused/);
  assert.doesNotMatch(result.text, /Unbounded|Unused.*instance.tab/);
});
test("an unbounded namespace is reported instead of hiding all unused keys", async () => {
  const result = await check({ unused: "unused" }, 'declare const t: any; declare const key: string; t(`library:${key}`);');
  assert.equal(result.status, 1); assert.match(result.text, /Unbounded translation namespace/);
});
test("a backend error code from any production Rust module fails without a text in every locale", async () => {
  const result = await checkTree({
    ...backendCrate,
    ...backendLocales({ loader: { busy: "busy", optifineInvalid: "invalid", optifineOnlineUnavailable: "online" } }),
  });
  assert.equal(result.status, 1, result.text);
  assert.match(result.text, /backend error code loader\.switchBackupTooLarge in en-US, zh-CN \(looked up as settings\.errors\.loader\.switchBackupTooLarge or shell\.errors\.loader\.switchBackupTooLarge\)/);
  assert.match(result.text, /backend error code reset\.gameRunning in en-US, zh-CN/);
  assert.doesNotMatch(result.text, /loader\.(?:busy|optifineInvalid|optifineOnlineUnavailable|testOnly|fixtureOnly|commented|json)\b/);
  assert.doesNotMatch(result.text, /internal\.unexpected/);
});
test("backend error codes pass once each has a text in a namespace the UI looks codes up in", async () => {
  const result = await checkTree({
    ...backendCrate,
    ...backendLocales(
      { loader: { busy: "busy", optifineInvalid: "invalid", optifineOnlineUnavailable: "online", switchBackupTooLarge: "large" } },
      { reset: { gameRunning: "running" } },
    ),
  });
  assert.equal(result.status, 0, result.text);
  assert.match(result.text, /6 backend error codes/);
});
test("a Rust module the guard cannot find fails instead of being skipped", async () => {
  const missing = await checkTree({ ...backendCrate, "src-tauri/src/lib.rs": "mod errors;\nmod gone;\n", ...backendLocales({ loader: { busy: "busy" } }) });
  assert.equal(missing.status, 1); assert.match(missing.text, /Rust module gone declared in .*lib\.rs has no file/);
  const noCrate = await checkTree({ "src/app/example.ts": "export {};", ...backendLocales({}) });
  assert.equal(noCrate.status, 1); assert.match(noCrate.text, /Missing Rust crate root/);
});
