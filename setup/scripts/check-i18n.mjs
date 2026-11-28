// SPDX-License-Identifier: GPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const rootArgument = process.argv.indexOf("--root");
const root = rootArgument >= 0
  ? path.resolve(process.argv[rootArgument + 1])
  : fileURLToPath(new URL("../../", import.meta.url));
const setupRoot = path.join(root, "setup");
const localeRoot = path.join(setupRoot, "src", "i18n", "locales");
const requiredLocales = ["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "ru-RU", "es-ES"];
const errors = [];

function flatten(value, prefix, output) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") output.set(full, child);
    else if (child && typeof child === "object") flatten(child, full, output);
    else errors.push(`Non-string setup translation value: ${full}`);
  }
}

const localeMaps = new Map();
for (const locale of requiredLocales) {
  const file = path.join(localeRoot, `${locale}.json`);
  if (!fs.existsSync(file)) {
    errors.push(`Missing setup locale file: ${locale}.json`);
    continue;
  }
  const map = new Map();
  flatten(JSON.parse(fs.readFileSync(file, "utf8")), "", map);
  localeMaps.set(locale, map);
  for (const [key, value] of map) {
    if (!value.trim()) errors.push(`Empty setup translation: ${locale}/${key}`);
    if (value.includes("·")) {
      errors.push(`Disallowed middle-dot separator ("·") in setup translation: ${locale}/${key}`);
    }
    if (/(?:^|\s)\/(?:S|P|UPDATE|R|NS|NCRC|ARGS)\b|(?:^|\s)\/D=/i.test(value)) {
      errors.push(`Installer command-line flag in user-facing setup translation: ${locale}/${key}`);
    }
  }
}

const english = localeMaps.get("en-US") ?? new Map();
for (const [locale, map] of localeMaps) {
  if (locale === "en-US") continue;
  for (const key of english.keys()) {
    if (!map.has(key)) errors.push(`Missing setup ${locale} key: ${key}`);
  }
  for (const key of map.keys()) {
    if (!english.has(key)) errors.push(`Unexpected setup ${locale} key: ${key}`);
  }
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(?:test|spec|d)\.tsx?$/.test(entry.name) ? [target] : [];
  });
}

const files = sourceFiles(path.join(setupRoot, "src"));
const referencedExact = new Set();
const referencedPrefixes = [];

const allowedJsxLiterals = new Set(["Voxelight", "VOXELIGHT", "GPL-3.0"]);
function allowedLiteral(text) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || !/[A-Za-z\u4e00-\u9fff]/.test(normalized)) return true;
  return allowedJsxLiterals.has(normalized);
}

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const relative = path.relative(root, file).replaceAll("\\", "/");
  function visit(node) {
    if (ts.isJsxText(node)) {
      const raw = node.getText(source);
      if (raw.includes("·")) errors.push(`Disallowed middle-dot in JSX text: ${relative}`);
      if (!allowedLiteral(raw)) {
        const pos = source.getLineAndCharacterOfPosition(node.getStart(source));
        errors.push(`Hardcoded setup JSX text: ${relative}:${pos.line + 1} (${raw.trim().slice(0, 80)})`);
      }
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (["aria-label", "title", "placeholder", "alt", "label"].includes(name)) {
        if (node.initializer && ts.isStringLiteral(node.initializer) && !allowedLiteral(node.initializer.text)) {
          const pos = source.getLineAndCharacterOfPosition(node.initializer.getStart(source));
          errors.push(`Hardcoded setup attribute ${name}: ${relative}:${pos.line + 1} (${node.initializer.text})`);
        }
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === "t") {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) referencedExact.add(arg.text);
      if (arg && ts.isTemplateExpression(arg)) {
        referencedPrefixes.push(arg.head.text);
      }
    }
    if (ts.isStringLiteralLike(node) && english.has(node.text)) {
      referencedExact.add(node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

for (const key of referencedExact) {
  if (!english.has(key)) errors.push(`Missing setup translation key: ${key}`);
}
for (const key of english.keys()) {
  if (!referencedExact.has(key) && !referencedPrefixes.some((prefix) => key.startsWith(prefix))) {
    errors.push(`Unused setup translation key: ${key}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  `Setup i18n checks passed: ${localeMaps.size} locales, ${english.size} localized keys, ${files.length} TS/TSX files; zero missing, unused, or middle-dot keys.`,
);
