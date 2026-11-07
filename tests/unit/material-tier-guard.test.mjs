// SPDX-License-Identifier: GPL-3.0-only
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
const root = process.env.VX_ROOT ?? process.cwd();
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const files = walk(join(root, "src")).map((path) => ({ path, rel: relative(root, path).split(sep).join("/") }));
const source = files.filter(({ rel }) => /\.tsx$/.test(rel) && !/\.test\.tsx$/.test(rel) && !rel.startsWith("src/visual/glass/"));
const styles = files.filter(({ rel }) => rel.endsWith(".css"));
const read = (path) => readFileSync(path, "utf8");

// Chrome tier: the only JSX owners of a lens. Everything else is solid.
const GLASS_OWNERS = new Set([
  "src/app/FloatingNav.tsx:vx-floating-nav__indicator",
  "src/features/home/LaunchConsole.tsx:vx-launch-console__selector",
  "src/components/ui/AnchoredListbox.tsx:{className}",
  "src/features/library/InstanceDetailPage.tsx:vx-detail-manage__menu",
]);
const GLASS_TRIGGERS = new Set(["src/features/home/InstancePicker.tsx", "src/features/home/HomeAnimationSelector.tsx"]);

test("GlassSurface is only used by chrome-tier owners", () => {
  const found = [];
  for (const { path, rel } of source) for (const match of read(path).matchAll(/<GlassSurface\b[^>]*?className=(?:"([^"]+)"|\{([^}]+)\})/g))
    found.push(`${rel}:${match[1]?.split(/\s+/)[0] ?? `{${match[2].trim()}}`}`);
  assert.deepEqual(found.filter((owner) => !GLASS_OWNERS.has(owner)), []);
});

test("only home chrome selectors opt their trigger into glass", () => {
  const offenders = source.filter(({ path, rel }) => /material="glass"/.test(read(path)) && !GLASS_TRIGGERS.has(rel)).map(({ rel }) => rel);
  assert.deepEqual(offenders, []);
});

test("listbox popups are always glass, independent of the trigger material", () => {
  const text = read(join(root, "src/components/ui/AnchoredListbox.tsx"));
  assert.match(text, /<SelectSurface glass(?:=\{true\})? variant="dialog" className="vx-listbox-surface"/);
});

test("backdrop-filter is declared only by the glass system and the dialog scrim", () => {
  const ALLOWED = new Set(["src/visual/glass/glass.css"]);
  const offenders = [];
  for (const { path, rel } of styles) {
    if (ALLOWED.has(rel)) continue;
    for (const rule of read(path).matchAll(/([^{}]+)\{([^{}]*)\}/g)) for (const decl of rule[2].matchAll(/(?:-webkit-)?backdrop-filter\s*:\s*([^;]+)/g)) {
      if (decl[1].trim() === "none") continue;
      if (rel === "src/design/global.css" && rule[1].trim() === ".vx-dialog::backdrop") continue;
      offenders.push(`${rel}: ${rule[1].trim()} { backdrop-filter: ${decl[1].trim()} }`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("content surface tokens are opaque in every theme", () => {
  const tokens = read(join(root, "src/design/tokens.css"));
  const offenders = [];
  for (const m of tokens.matchAll(/(--(?:surface-panel|surface-card|surface-solid|selection-fill|bg-raised))\s*:\s*([^;]+);/g))
    if (/transparent|rgba\([^)]*,\s*0?\.\d+\s*\)/.test(m[2])) offenders.push(`${m[1]}: ${m[2].trim()}`);
  assert.deepEqual(offenders, []);
});

test("feature styles never thin an opaque surface token into a translucent card", () => {
  const CHROME = new Set(["src/app/shell.css"]);
  const offenders = [];
  for (const { path, rel } of styles) {
    if (CHROME.has(rel) || rel.startsWith("src/visual/")) continue;
    for (const m of read(path).matchAll(/background(?:-color)?\s*:\s*color-mix\(\s*in srgb\s*,\s*var\(--(surface-solid|surface-card|bg-raised|surface-panel)\)\s*\d+%\s*,\s*transparent\s*\)/g))
      offenders.push(`${rel}: ${m[0]}`);
  }
  assert.deepEqual(offenders, []);
});

test("the legacy surface-glass token is never used outside the visual system", () => {
  const offenders = files.filter(({ rel }) => !rel.startsWith("src/visual/") && /\.(?:css|tsx?|jsx?)$/.test(rel))
    .flatMap(({ path, rel }) => [...read(path).matchAll(/var\(\s*--surface-glass\b/g)].map(() => rel));
  assert.deepEqual(offenders, []);
});
