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
    if (declaration.prop.startsWith("--")) return;
    const label = `${filename}:${declaration.source?.start?.line ?? "?"}`;
    if (/^border(?:-(?:top|bottom)-(?:left|right))?-radius$/.test(declaration.prop)) {
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
