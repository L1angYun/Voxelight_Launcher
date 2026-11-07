import { parse } from "postcss";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

// These surfaces inherit a changing host curve. A new independent radius must
// use a token; adding another inheritance exception requires explicit review.
const inheritedCurves = new Map([
  ["src/components/ui/AnchoredListbox.css", [".vx-select__button"]],
  ["src/components/ui/selection.css", [".vx-selection__mark"]],
  ["src/features/home/home.css", [".vx-launch-console__content"]],
  ["src/visual/lattice/lattice.css", [".vx-lattice-frame"]],
]);
const spacingScale = new Map(Object.entries({
  "--space-1": "4px", "--space-2": "8px", "--space-3": "12px", "--space-4": "16px",
  "--space-5": "24px", "--space-6": "32px", "--space-7": "48px", "--space-8": "64px",
}));
const panelCurves = new Map([["--radius-sm", "6px"], ["--radius-md", "12px"], ["--radius-lg", "12px"]]);
// R2-05 acceptance explicitly exempts window buttons and Lens controls.
// Keep only this existing window selector/value pair exempt, not feature buttons
// in general: docs/superpowers/specs/2026-11-05-voxelight-review-round2-fixes.md.
const windowControlGeometry = new Map([["min-height", "34px"], ["border-radius", "var(--radius-window-control)"]]);
function approvedWindowGeometry(declaration, filename, selectors) {
  return filename === "src/app/shell.css" && selectors.length === 1
    && selectors[0].trim() === ".vx-window-chrome__controls .vx-button"
    && windowControlGeometry.get(declaration.prop) === declaration.value;
}
function pixelEncodedToken(name) {
  return /\d+(?:\.\d+)?px(?:-|$)/i.test(name)
    || /^--(?:text|radius)-\d+(?:$|-)/.test(name)
    || /^--space-\d+$/.test(name) && !spacingScale.has(name);
}
function repeatsPixelValue(name, value) {
  if (!name.startsWith("--") || spacingScale.has(name)) return false;
  const suffix = /(\d+)$/.exec(name);
  const pixels = /^\+?(\d+(?:\.\d*)?|\.\d+)px$/i.exec(value.trim());
  return Boolean(suffix && pixels && Number(suffix[1]) === Number(pixels[1]));
}
function variableReferences(value) {
  const names = []; let quote = "";
  for (let at = 0; at < value.length; at++) {
    const character = value[at];
    if (character === "\\") { at++; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (value.slice(at, at + 2) === "/*") {
      const end = value.indexOf("*/", at + 2); at = end < 0 ? value.length : end + 1; continue;
    }
    const variable = /^var\(\s*(--[\w-]+)/i.exec(value.slice(at));
    if (variable) { names.push(variable[1]); at += variable[0].length - 1; }
  }
  return names;
}

// Split selectors only at their outer level. A descendant icon or a :has()
// predicate does not turn its containing row into a Button geometry rule.
function selectorParts(value, separator) {
  const result = []; let depth = 0, quote = "", start = 0;
  for (let at = 0; at < value.length; at++) {
    const character = value[at];
    if (character === "\\") { at++; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === "(" || character === "[") depth++;
    else if (character === ")" || character === "]") depth--;
    else if (!depth && separator.test(character)) {
      if (value.slice(start, at).trim()) result.push(value.slice(start, at).trim());
      start = at + 1;
    }
  }
  if (value.slice(start).trim()) result.push(value.slice(start).trim());
  return result;
}
function targetsComponent(selector, family) {
  const subject = selectorParts(selector, /[\s>+~]/).at(-1) ?? "";
  if (subject.includes("::")) return false;
  let plain = "", alternate = false, cursor = 0;
  const functions = /:([\w-]+)\(/g;
  for (let match; (match = functions.exec(subject));) {
    plain += subject.slice(cursor, match.index);
    let depth = 1, end = functions.lastIndex;
    for (; end < subject.length && depth; end++) {
      if (subject[end] === "\\") { end++; continue; }
      if (subject[end] === "(") depth++;
      else if (subject[end] === ")") depth--;
    }
    if (match[1] === "is" || match[1] === "where")
      alternate ||= selectorParts(subject.slice(functions.lastIndex, end - 1), /,/).some(part => targetsComponent(part, family));
    cursor = end; functions.lastIndex = end;
  }
  plain += subject.slice(cursor);
  return family.test(plain) || alternate;
}
function featureDeclaration(declaration, filename) {
  if (filename.startsWith("src/features/")) return true;
  for (let owner = declaration.parent; owner; owner = owner.parent)
    if (owner.type === "atrule" && owner.name === "layer" && /(?:^|\.)features$/.test(owner.params)) return true;
  return false;
}
function tokenRadius(value) {
  let rest = "";
  for (let at = 0; at < value.length;) {
    if (value.slice(at, at + 4) === "var(") {
      let depth = 1; at += 4;
      while (at < value.length && depth) { if (value[at] === "(") depth++; if (value[at] === ")") depth--; at++; }
      if (depth) return false;
      rest += " ";
    } else rest += value[at++];
  }
  return rest.trim().split(/[\s/]+/).filter(Boolean).every(part => part === "0" || part === "50%");
}
export function inspectStylesheet(css, filename) {
  const errors = []; let spacingPixels = 0;
  let sheet;
  try { sheet = parse(css, { from: filename }); }
  catch (error) { return { errors: [`${filename}: invalid CSS: ${error.reason}`], spacingPixels }; }
  sheet.walkDecls(declaration => {
    const label = `${filename}:${declaration.source?.start?.line ?? "?"}`;
    const names = [declaration.prop, ...variableReferences(declaration.value)];
    for (const name of new Set(names.filter(name => pixelEncodedToken(name)
      || name === declaration.prop && repeatsPixelValue(name, declaration.value))))
      errors.push(`${label}: pixel-encoded custom property is not a design scale (${name})`);
    if (spacingScale.has(declaration.prop) && declaration.value !== spacingScale.get(declaration.prop))
      errors.push(`${label}: ${declaration.prop} must retain its scale value ${spacingScale.get(declaration.prop)}`);
    if (panelCurves.has(declaration.prop) && declaration.value !== panelCurves.get(declaration.prop)
      && !(declaration.prop === "--radius-lg" && declaration.value === "var(--radius-md)"))
      errors.push(`${label}: ${declaration.prop} must resolve to ${panelCurves.get(declaration.prop)}`);
    if (declaration.prop === "--radius-window-control" && declaration.value !== "8px")
      errors.push(`${label}: --radius-window-control must retain the R2-05 window-control radius 8px`);
    if (declaration.prop.startsWith("--")) return;
    const selectors = declaration.parent.type === "rule" ? declaration.parent.selectors : [];
    const radiusProperty = /^border(?:-(?:top|bottom)-(?:left|right))?-radius$/.test(declaration.prop);
    if (featureDeclaration(declaration, filename) && (radiusProperty || ["height", "min-height", "block-size", "min-block-size"].includes(declaration.prop))
      && selectors.some(selector => targetsComponent(selector, /\.vx-button(?:--[\w-]+)?(?![\w-])/))
      && !approvedWindowGeometry(declaration, filename, selectors))
      errors.push(`${label}: feature styles cannot override button geometry (${declaration.prop})`);
    if (radiusProperty
      && selectors.some(selector => targetsComponent(selector, /\.vx-(?:panel|card)(?:--[\w-]+)?(?![\w-])/))
      && !/^var\(--radius-(?:sm|md|lg)\)$/.test(declaration.value))
      errors.push(`${label}: panel/card radius must use the six or twelve pixel scale (${declaration.value})`);
    if (radiusProperty) {
      const allowedInheritance = declaration.value === "inherit" && declaration.parent.type === "rule"
        && declaration.parent.selector.split(",").every(selector => inheritedCurves.get(filename)?.includes(selector.trim()));
      if (!allowedInheritance && !tokenRadius(declaration.value)) errors.push(`${label}: radius must use a token, 0 or 50% (${declaration.value})`);
    }
    if (declaration.prop === "font-size" && /[\d.]px\b/i.test(declaration.value))
      errors.push(`${label}: font-size must use a token (${declaration.value})`);
    if (/^(?:padding|margin)(?:-.+)?$|^(?:row-|column-)?gap$/.test(declaration.prop))
      spacingPixels += (declaration.value.match(/-?(?:\d*\.)?\d+px\b/gi) ?? []).length;
  });
  return { errors, spacingPixels };
}
export function compareSpacingBudget(actual, maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 0) return ["Spacing baseline must be a nonnegative integer"];
  return actual <= maximum ? [] : [`Spacing pixel literals increased: ${actual} > ${maximum}`];
}
export function repeatedSelectorLists(sheets) {
  const seen = new Map(), errors = [];
  for (const [filename, css] of Object.entries(sheets)) parse(css, { from: filename }).walkRules(rule => {
    const conditions = [];
    for (let parent = rule.parent; parent?.type !== "root"; parent = parent.parent) {
      if (parent.type === "atrule") conditions.unshift(`@${parent.name} ${parent.params}`);
      else if (parent.type === "rule") conditions.unshift(parent.selector);
    }
    const location = `${filename}:${rule.source.start.line}`, duplicates = [];
    for (const selector of rule.selectors.map(value => value.trim())) {
      const key = [...conditions, selector].join(" / ");
      if (seen.has(key)) duplicates.push(`${selector} (first at ${seen.get(key)})`);
      else seen.set(key, location);
    }
    if (duplicates.length) errors.push(`${location}: repeated selectors: ${duplicates.join(", ")}`);
  });
  return errors;
}
export function inspectDesign(root) {
  const files = [], errors = [], counts = {};
  const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) walk(target); else if (entry.name.endsWith(".css")) files.push(target);
  } };
  walk(join(root, "src"));
  for (const file of files.sort()) {
    const name = relative(root, file).replaceAll("\\", "/");
    const inspected = inspectStylesheet(readFileSync(file, "utf8"), name);
    errors.push(...inspected.errors); counts[name] = inspected.spacingPixels;
  }
  const library = {};
  for (const name of ["library-grid.css", "instance-detail.css"]) {
    const filename = `src/features/library/${name}`;
    try { library[filename] = readFileSync(join(root, filename), "utf8"); }
    catch { errors.push(`Missing split library stylesheet: ${filename}`); }
  }
  const libraryLines = Object.values(library).reduce((sum, css) => sum + css.trimEnd().split(/\r?\n/).length, 0);
  if (libraryLines > 900) errors.push(`Split library styles exceed 900 lines: ${libraryLines}`);
  errors.push(...repeatedSelectorLists(library));
  return { errors, files: counts, spacingPixels: Object.values(counts).reduce((sum, count) => sum + count, 0) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const result = inspectDesign(root), baselinePath = join(root, "scripts/design-token-baseline.json");
  if (process.argv.includes("--write-baseline")) {
    if (result.errors.length) throw new Error("Fix token violations before recording the spacing baseline\n" + result.errors.join("\n"));
    writeFileSync(baselinePath, JSON.stringify({ spacingPixels: result.spacingPixels, files: result.files }, null, 2) + "\n");
  } else {
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
    result.errors.push(...compareSpacingBudget(result.spacingPixels, baseline.spacingPixels));
  }
  if (result.errors.length) { console.error(result.errors.join("\n")); process.exitCode = 1; }
  else console.log(`Design tokens passed: ${Object.keys(result.files).length} stylesheets, ${result.spacingPixels} spacing pixel literals.`);
}
