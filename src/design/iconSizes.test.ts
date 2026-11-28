import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ICON, ICON_SIZES, ICON_STROKE, ICON_STROKE_SMALL } from "./icons";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.tsx$/.test(entry.name) && !/\.(?:test|spec)\.tsx$/.test(entry.name) ? [target] : [];
  });
}

function pixelValue(css: string, name: string): number | null {
  const match = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(css);
  return match ? Number(match[1]) : null;
}

/**
 * Legacy literals that still live in Wave-2 files outside WP-02's ownership.
 * The ratchet can only go down: the page packages replace them with ICON.*,
 * and WP-11 zeroes it. Adding a new literal here is a regression.
 * 86 is the measured 0.7.0-beta.2 baseline (R9 Wave 1).
 */
const LEGACY_ICON_LITERAL_BASELINE = 86;

function lucideImports(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "lucide-react") continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) names.add(element.name.text);
    }
  }
  return names;
}

function attributes(node: ts.JsxOpeningLikeElement) {
  return node.attributes.properties.filter((property): property is ts.JsxAttribute => ts.isJsxAttribute(property));
}

function numericInitializer(attribute: ts.JsxAttribute): number | null {
  const initializer = attribute.initializer;
  if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression) return null;
  return ts.isNumericLiteral(initializer.expression) ? Number(initializer.expression.text) : null;
}

function scanIconLiterals(): string[] {
  const violations: string[] = [];
  for (const file of sourceFiles("src")) {
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const lucide = lucideImports(source);
    // A capitalized `Icon` binding is the project's dynamic lucide slot
    // (`const Icon = icons[id]`); it is covered when the file imports lucide.
    if (!lucide.size && !/\bIcon\b/.test(text)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const tag = node.tagName;
        const name = ts.isIdentifier(tag) ? tag.text : "";
        const isIcon = lucide.has(name) || (name === "Icon" && lucide.size > 0);
        if (isIcon) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          for (const attribute of attributes(node)) {
            const attributeName = attribute.name.getText(source);
            if (attributeName === "strokeWidth")
              violations.push(`${file}:${line} <${name}> hard-codes strokeWidth`);
            if (attributeName !== "size") continue;
            const pixels = numericInitializer(attribute);
            if (pixels !== null && !(ICON_SIZES as readonly number[]).includes(pixels))
              violations.push(`${file}:${line} <${name}> size ${pixels} is outside the icon scale`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

describe("icon system", () => {
  it("exposes the five-step ICON scale used by every lucide size", () => {
    expect(ICON).toEqual({ xs: 12, sm: 14, md: 16, lg: 20, xl: 24 });
    expect(new Set(ICON_SIZES)).toEqual(new Set(Object.values(ICON)));
    expect(ICON_SIZES).toEqual([...ICON_SIZES].sort((a, b) => a - b));
  });

  it("keeps ICON, stroke widths and tokens.css in sync", () => {
    const tokens = readFileSync("src/design/tokens.css", "utf8");
    expect(pixelValue(tokens, "--icon-xs")).toBe(ICON.xs);
    expect(pixelValue(tokens, "--icon-sm")).toBe(ICON.sm);
    expect(pixelValue(tokens, "--icon-md")).toBe(ICON.md);
    expect(pixelValue(tokens, "--icon-lg")).toBe(ICON.lg);
    expect(pixelValue(tokens, "--icon-xl")).toBe(ICON.xl);
    expect(pixelValue(tokens, "--icon-stroke")).toBe(ICON_STROKE);
    expect(pixelValue(tokens, "--icon-stroke-small")).toBe(ICON_STROKE_SMALL);
  });

  it("draws lucide at an absolute stroke that does not scale with the icon box", () => {
    const global = readFileSync("src/design/global.css", "utf8");
    expect(global).toMatch(/svg\.lucide\s*\{[^}]*stroke-width:\s*var\(--icon-stroke\)/);
    expect(global).toMatch(/svg\.lucide\s+:is\([^)]*\)\s*\{[^}]*vector-effect:\s*non-scaling-stroke/);
    expect(global).toMatch(/svg\.lucide:is\(\[width="12"\], \[width="14"\]\)\s*\{[^}]*--icon-stroke:\s*var\(--icon-stroke-small\)/);
  });

  it("does not add icon-size or stroke literals beyond the staged migration baseline", () => {
    const violations = scanIconLiterals();
    // The count must only shrink as Wave-2 packages adopt ICON.*.
    expect(violations.length, violations.slice(0, 12).join("\n")).toBeLessThanOrEqual(LEGACY_ICON_LITERAL_BASELINE);
  });
});
