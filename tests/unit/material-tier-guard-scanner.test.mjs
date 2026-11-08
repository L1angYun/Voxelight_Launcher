// SPDX-License-Identifier: GPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("./material-tier-guard.test.mjs", import.meta.url));

function fixtureGuard(t, content, filename = "src/features/demo/Demo.tsx") {
  const root = mkdtempSync(join(tmpdir(), "voxelight-material-guard-"));
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  write("src/components/ui/AnchoredListbox.tsx", '<SelectSurface glass variant="dialog" className="vx-listbox-surface" />');
  write("src/design/tokens.css", ":root { --surface-panel: #fff; }");
  write(filename, content);
  const env = { ...process.env, VX_ROOT: root };
  // A nested runner must not inherit the parent's internal test-worker context.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", guard], {
    cwd: root, env, encoding: "utf8", windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.match(output, /^1\.\.[1-9]\d*$/m, "the isolated owner guard must actually execute its tests");
  return { status: result.status, output };
}

test("material owner guard rejects a GlassSurface without a className", t => {
  const result = fixtureGuard(t, 'export const Demo = () => <GlassSurface variant="control" />;');
  assert.equal(result.status, 1, "the unnamed GlassSurface must be compared with the owner allowlist");
  assert.match(result.output, /src\/features\/demo\/Demo\.tsx:<no-className>/);
});

test("material owner guard sees a className after a greater-than JSX prop expression", t => {
  const result = fixtureGuard(t, 'export const Demo = () => <GlassSurface pressure={count > 0} className="vx-content-lens" />;');
  assert.equal(result.status, 1, "a greater-than expression must not hide the later className");
  assert.match(result.output, /src\/features\/demo\/Demo\.tsx:vx-content-lens/);
});

test("material owner guard retains approved owners when a prop contains a greater-than sign", t => {
  const result = fixtureGuard(t, 'export const Demo = () => <GlassSurface pressure={count > 0} className="vx-floating-nav__indicator" />;', "src/app/FloatingNav.tsx");
  assert.equal(result.status, 0);
});

test("material owner guard does not treat literal JSX-looking strings as component ownership", t => {
  const result = fixtureGuard(t, 'const example = "<GlassSurface />"; /* <GlassSurface variant="control" /> */');
  assert.equal(result.status, 0);
});
