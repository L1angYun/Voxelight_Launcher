import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectTranslationUsage } from "./i18n-usage.mjs";

const rootArgument = process.argv.indexOf("--root");
const root = rootArgument >= 0 ? path.resolve(process.argv[rootArgument + 1]) : fileURLToPath(new URL("../", import.meta.url));
const localeRoot = path.join(root, "src", "i18n", "locales");
const requiredLocales = ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "ru-RU", "es-ES"];
const discoveredLocales = fs.readdirSync(localeRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const locales = rootArgument >= 0 ? discoveredLocales : requiredLocales;
const errors = [];
if (rootArgument < 0) {
  for (const locale of requiredLocales) {
    if (!discoveredLocales.includes(locale)) errors.push(`Missing locale directory: ${locale}`);
  }
}

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
const localeKeys = new Map();
for (const locale of locales) {
  const directory = path.join(localeRoot, locale);
  const namespaces = fs.readdirSync(directory).filter((file) => file.endsWith(".json")).sort();
  const keys = new Set();
  localeKeys.set(locale, keys);
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

// Splits Rust source into code with comments and literals blanked (offsets kept)
// and the string literals it contains.
function lexRust(text) {
  const blank = (from, to) => text.slice(from, to).replace(/[^\n]/g, " ");
  const literals = [];
  let code = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("//", i)) {
      const newline = text.indexOf("\n", i);
      const end = newline < 0 ? text.length : newline;
      code += blank(i, end);
      i = end;
      continue;
    }
    if (text.startsWith("/*", i)) {
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text.startsWith("/*", j)) { depth++; j += 2; }
        else if (text.startsWith("*/", j)) { depth--; j += 2; if (!depth) break; }
        else j++;
      }
      code += blank(i, j);
      i = j;
      continue;
    }
    const afterIdentifier = /[A-Za-z0-9_]/.test(text[i - 1] ?? "");
    const raw = afterIdentifier ? null : /^b?r(#*)"/.exec(text.slice(i, i + 260));
    if (raw || text[i] === '"' || (!afterIdentifier && text.startsWith('b"', i))) {
      const valueStart = i + (raw ? raw[0].length : text[i] === '"' ? 1 : 2);
      let valueEnd = valueStart;
      if (raw) {
        valueEnd = text.indexOf(`"${raw[1]}`, valueStart);
        if (valueEnd < 0) valueEnd = text.length;
      } else {
        while (valueEnd < text.length && text[valueEnd] !== '"') valueEnd += text[valueEnd] === "\\" ? 2 : 1;
      }
      const end = Math.min(text.length, valueEnd + 1 + (raw ? raw[1].length : 0));
      literals.push({ value: text.slice(valueStart, valueEnd), start: i, end });
      code += `""${blank(i + 2, end)}`;
      i = end;
      continue;
    }
    const character = text[i] === "'" && /^'(?:\\u\{[0-9A-Fa-f]{1,6}\}|\\x[0-9A-Fa-f]{2}|\\.|[^\\'\n])'/u.exec(text.slice(i, i + 12));
    if (character) {
      code += `'${" ".repeat(character[0].length - 2)}'`;
      i += character[0].length;
      continue;
    }
    code += text[i];
    i++;
  }
  return { code, literals };
}

// Offset ranges of items that only exist in test builds.
function testOnlyRanges(code) {
  if (/#!\[\s*cfg\(\s*test\s*\)\s*\]/.test(code)) return [[0, code.length]];
  const ranges = [];
  for (const match of code.matchAll(/#\[\s*(?:cfg\(\s*(?:test|all\(\s*test\b[^\]]*)\s*\)|(?:tokio::)?test)\s*\]/g)) {
    let i = match.index + match[0].length;
    for (;;) {
      while (/\s/.test(code[i] ?? "")) i++;
      if (!code.startsWith("#[", i)) break;
      let depth = 0;
      for (; i < code.length; i++) {
        if (code[i] === "[") depth++;
        else if (code[i] === "]" && --depth === 0) { i++; break; }
      }
    }
    const item = /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:async|const|unsafe|extern(?:\s+"")?)\s+)*(?:fn|mod|impl|struct|enum|trait|union|const|static|use|type|macro_rules!)\b/
      .test(code.slice(i, i + 120));
    let depth = 0;
    let end = code.length;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth < 0) { end = i; break; }
        if (depth === 0 && c === "}") { end = i + 1; break; }
      } else if (depth === 0 && (c === ";" || (c === "," && !item))) { end = i + 1; break; }
    }
    ranges.push([match.index, end]);
  }
  return ranges;
}

// Every Rust file compiled into the launcher, following `mod` declarations
// from the crate roots and skipping test-only items and modules.
function productionRustSources(sourceRoot) {
  const sources = [];
  const problems = [];
  const owners = new Set();
  const queue = ["lib.rs", "main.rs"].map((name) => path.join(sourceRoot, name)).filter((file) => fs.existsSync(file));
  if (!queue.length) problems.push(`Missing Rust crate root: ${path.relative(root, path.join(sourceRoot, "lib.rs"))}`);
  for (const file of queue) owners.add(file);
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const { code, literals } = lexRust(fs.readFileSync(file, "utf8"));
    const ranges = testOnlyRanges(code);
    const testOnly = (offset) => ranges.some(([start, end]) => offset >= start && offset < end);
    sources.push({ file, code, literals: literals.filter((literal) => !testOnly(literal.start)) });
    const directory = owners.has(file) || path.basename(file) === "mod.rs" ? path.dirname(file) : file.slice(0, -3);
    for (const match of code.matchAll(/((?:#\[[^\]]*\]\s*)*)(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g)) {
      if (testOnly(match.index + match[0].lastIndexOf("mod"))) continue;
      const attributes = match[1];
      const pathLiteral = /#\[\s*path\s*=/.test(attributes)
        ? literals.find((literal) => literal.start >= match.index && literal.start < match.index + attributes.length)
        : undefined;
      let target;
      if (pathLiteral) {
        target = path.join(path.dirname(file), pathLiteral.value);
        owners.add(target);
      } else {
        const direct = path.join(directory, `${match[2]}.rs`);
        target = fs.existsSync(direct) ? direct : path.join(directory, match[2], "mod.rs");
      }
      if (fs.existsSync(target)) queue.push(target);
      else problems.push(`Rust module ${match[2]} declared in ${path.relative(root, file)} has no file: ${path.relative(root, target)}`);
    }
  }
  return { sources, problems };
}

// A backend error code looks like `family.name`. A family is an error family
// once one of its codes is passed to AppError::new, returned from a match arm
// or is the value of a block; every other literal of that family is then a
// code too, except file and host names.
const nonCodeSuffixes = new Set([
  "args", "bat", "bin", "cfg", "cmd", "com", "dat", "dll", "exe", "gif", "html", "ico", "info", "ini", "io", "jar",
  "jpeg", "jpg", "js", "json", "localhost", "lock", "log", "md", "mcmeta", "mrpack", "net", "org", "packmeta", "part",
  "png", "properties", "ps1", "rs", "sh", "tmp", "toml", "txt", "webp", "xml", "yaml", "yml", "zip",
]);
function backendErrorCodes(sources) {
  const shaped = [];
  for (const { code, literals } of sources) {
    for (const literal of literals) {
      const match = /^([a-z][A-Za-z0-9]*)\.([a-z][A-Za-z0-9]*)$/.exec(literal.value);
      if (!match || nonCodeSuffixes.has(match[2])) continue;
      const before = code.slice(Math.max(0, literal.start - 80), literal.start).trimEnd();
      const after = code.slice(literal.end, literal.end + 16).trimStart();
      const producesCode = /\bAppError::new\($/.test(before) || before.endsWith("=>") || (before.endsWith("{") && after.startsWith("}"));
      shaped.push({ value: literal.value, family: match[1], producesCode });
    }
  }
  const families = new Set(shaped.filter((item) => item.producesCode).map((item) => item.family));
  return new Set(shaped.filter((item) => families.has(item.family)).map((item) => item.value));
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
  "繁體中文",
  "English",
  "日本語",
  "한국어",
  "Русский",
  "Español",
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
    if (entry.isDirectory()) return entry.name === "test" || entry.name === "__tests__" ? [] : sourceFiles(target);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(?:test|spec|d)\.tsx?$/.test(entry.name) ? [target] : [];
  });
}

const files = sourceFiles(path.join(root, "src"));

const rust = productionRustSources(path.join(root, "src-tauri", "src"));
errors.push(...rust.problems);
const backendCodes = backendErrorCodes(rust.sources);
// The namespaces the UI looks backend codes up in, such as `shell:errors.${code}`.
const errorNamespaces = [...new Set(files.flatMap((file) =>
  [...fs.readFileSync(file, "utf8").matchAll(/[`"']([a-z][A-Za-z0-9]*):errors\.\$\{/g)].map((match) => match[1])))].sort();
if (backendCodes.size && !errorNamespaces.length) errors.push("No UI lookup of backend error codes (`<namespace>:errors.${code}`) was found");
const pluralBase = (key) => key.replace(/_(?:zero|one|two|few|many|other)$/, "");
const localeBaseKeys = new Map(locales.map((locale) => [locale, new Set([...localeKeys.get(locale)].map(pluralBase))]));
for (const code of [...backendCodes].sort()) {
  const lookups = code === "internal.unexpected"
    ? ["common.errors.internalUnexpected"]
    : errorNamespaces.map((namespace) => `${namespace}.errors.${code}`);
  const missing = locales.filter((locale) => !lookups.some((key) => localeBaseKeys.get(locale).has(key)));
  if (missing.length && lookups.length) {
    errors.push(`Missing translation for backend error code ${code} in ${missing.join(", ")} (looked up as ${lookups.join(" or ")})`);
  }
}

for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
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

const usage = collectTranslationUsage(files, [...new Set([...translationKeys].map(key => key.split(".")[0]))]);
errors.push(...usage.errors);
const known = new Set([...translationKeys].map(usage.canonical));
for (const reference of usage.exact) if (!known.has(reference)) errors.push(`Missing translation key: ${reference}`);
for (const key of translationKeys) {
  // Backend codes are delivered at runtime and intentionally form a whitelist.
  if (key.includes(".errors.")) continue;
  // processes.rs reads these labels from library.json. Rust tests enforce required keys in each locale.
  if (key.startsWith("library.diagnosticReport.")) continue;
  if (!usage.exact.has(usage.canonical(key)) && !usage.patterns.some(pattern => pattern.test(key))) errors.push(`Unused translation key: ${key}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`i18n checks passed: ${locales.length} locales, ${translationKeys.size} localized keys, ${backendCodes.size} backend error codes, ${files.length} TS/TSX files; no unused keys outside runtime error families.`);
