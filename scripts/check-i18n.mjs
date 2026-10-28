import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const localeRoot = path.join(root, "src", "i18n", "locales");
const locales = ["zh-CN", "en-US"];
const errors = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function flatten(value, prefix, output) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") output.set(full, child);
    else if (child && typeof child === "object") flatten(child, full, output);
    else errors.push(`Non-string translation value: ${full}`);
  }
}

const translationKeys = new Set();
for (const locale of locales) {
  const directory = path.join(localeRoot, locale);
  const namespaces = fs.readdirSync(directory).filter((file) => file.endsWith(".json")).sort();
  const keys = new Set();
  for (const namespace of namespaces) {
    const values = new Map();
    flatten(readJson(path.join(directory, namespace)), "", values);
    for (const [key, value] of values) {
      const full = `${namespace.slice(0, -5)}.${key}`;
      if (!value.trim()) errors.push(`Empty translation: ${locale}/${full}`);
      keys.add(full);
      translationKeys.add(full);
    }
  }
  if (locale === "en-US") continue;
  const englishKeys = flattenNamespaces("en-US");
  const canonical = (key) => key.replace(/_(?:zero|one|few|many|other)$/, "");
  const canonicalKeys = new Set([...keys].map(canonical));
  const canonicalEnglish = new Set([...englishKeys].map(canonical));
  const missingEnglish = [...canonicalEnglish].filter((key) => !canonicalKeys.has(key));
  const missingLocale = [...canonicalKeys].filter((key) => !canonicalEnglish.has(key));
  for (const key of missingEnglish) errors.push(`Missing ${locale} key: ${key}`);
  for (const key of missingLocale) errors.push(`Unexpected ${locale} key: ${key}`);
}

function flattenNamespaces(locale) {
  const keys = new Set();
  const directory = path.join(localeRoot, locale);
  for (const namespace of fs.readdirSync(directory).filter((file) => file.endsWith(".json"))) {
    const values = new Map();
    flatten(readJson(path.join(directory, namespace)), "", values);
    for (const key of values.keys()) keys.add(`${namespace.slice(0, -5)}.${key}`);
  }
  return keys;
}

const backendSource = fs.readFileSync(path.join(root, "src-tauri", "src", "errors.rs"), "utf8");
const backendCodes = new Set(
  [...backendSource.matchAll(/["']((?:instance|backup|resource|auth|download|server|config|skin|internal)\.[A-Za-z][A-Za-z0-9]*)["']/g)]
    .map((match) => match[1]),
);
for (const code of backendCodes) {
  const special = code === "internal.unexpected" && translationKeys.has("common.errors.internalUnexpected");
  if (!special && ![...translationKeys].some((key) => key.endsWith(`.${code}`) || key === code)) {
    errors.push(`Missing translation for backend error code: ${code}`);
  }
}

const allowedLiterals = new Set([
  "V",
  "oxelight",
  "Voxelight",
  "Minecraft",
  "Minecraft EULA",
  "Vanilla",
  "Java",
  "PID",
  "MOTD",
  "Steve",
  "Alex",
  "Classic",
  "Slim",
  "Microsoft Client ID",
  "CurseForge API Key",
  "A Minecraft Server",
  "Modrinth",
  "CurseForge",
  "简体中文",
  "English",
  "/s",
  "example.org:25565",
  "· Java",
]);

function allowedLiteral(text) {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || !/[A-Za-z\u4e00-\u9fff]/.test(normalized)) return true;
  if (allowedLiterals.has(normalized)) return true;
  if (/^(?:https?:|blob:|data:|#|xxxxxxxx|127\.)/.test(normalized)) return true;
  if (/^[·\s]*PID$/.test(normalized)) return true;
  return false;
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [target] : [];
  });
}

const files = [
  ...sourceFiles(path.join(root, "src", "app")),
  ...sourceFiles(path.join(root, "src", "features")),
  ...sourceFiles(path.join(root, "src", "visual")),
  ...sourceFiles(path.join(root, "src", "components", "ui")),
  path.join(root, "src", "components", "PlayerAvatar.tsx"),
  path.join(root, "src", "components", "WorldScene.tsx"),
];

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const relative = path.relative(root, file).replaceAll("\\", "/");
  function report(node, value, kind) {
    if (allowedLiteral(value)) return;
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    errors.push(`Hardcoded ${kind}: ${relative}:${position.line + 1} (${value.trim().replace(/\s+/g, " ").slice(0, 100)})`);
  }
  function visit(node) {
    if (ts.isJsxText(node)) report(node, node.getText(source), "JSX text");
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      if (["aria-label", "title", "placeholder", "alt", "label", "retryLabel", "closeLabel"].includes(name)) {
        const initializer = node.initializer;
        if (initializer && ts.isStringLiteral(initializer)) report(initializer, initializer.text, `accessibility attribute ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`i18n checks passed: ${locales.length} locales, ${translationKeys.size} localized keys, ${backendCodes.size} backend error codes, ${files.length} TSX files.`);
