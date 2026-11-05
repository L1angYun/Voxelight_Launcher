import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../../scripts/check-i18n.mjs", import.meta.url));
async function check(keys, code, extension = "ts") {
  const prefix = join(tmpdir(), "voxelight-i18n-guard-");
  const root = await mkdtemp(prefix);
  try {
    for (const locale of ["zh-CN", "en-US"]) {
      await mkdir(join(root, "src/i18n/locales", locale), { recursive: true });
      await writeFile(join(root, "src/i18n/locales", locale, "library.json"), JSON.stringify(keys));
    }
    await mkdir(join(root, "src/app"), { recursive: true });
    await mkdir(join(root, "src-tauri/src"), { recursive: true });
    await writeFile(join(root, "src-tauri/src/errors.rs"), "");
    await writeFile(join(root, "src/app/example." + extension), code);
    const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    return { status: result.status, text: result.stdout + result.stderr };
  } finally {
    assert(resolve(root).startsWith(resolve(prefix)));
    await rm(root, { recursive: true, force: true });
  }
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
