import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Under Tauri the dialog plugin turns the browser's confirm into a call that
// does not block, so `if (!window.confirm(...))` never stops a destructive
// action. Every confirmation must go through the awaited useConfirm() dialog
// (src/components/ui/ConfirmDialog.tsx).
//
// A bare `confirm(...)` is the same native call when nothing in scope binds
// the name: it compiles against lib.dom's `confirm(): boolean`, and `await`
// on that boolean is allowed, so a copied `await confirm(...)` in a component
// that never called useConfirm() would run the action without asking. The
// matcher parses the source, so comments, strings and method names never
// count, and a `confirm` bound by a declaration, parameter, destructuring or
// import in an enclosing scope is the awaited dialog.

const root = fileURLToPath(new URL("../..", import.meta.url));
const sourceRoot = join(root, "src");
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "top", "parent"]);
const FORWARDERS = new Set(["call", "apply", "bind"]);

function scriptKind(fileName) {
  if (/\.tsx$/.test(fileName)) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(fileName)) return ts.ScriptKind.TS;
  if (/\.jsx$/.test(fileName)) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
  // `(0, confirm)(message)` calls the last operand.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) return unwrap(node.right);
  return node;
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
}

function isGlobalObject(node) {
  const target = unwrap(node);
  if (ts.isIdentifier(target)) return GLOBAL_OBJECTS.has(target.text);
  const name = memberName(target);
  return name !== undefined && GLOBAL_OBJECTS.has(name);
}

function bindsName(name) {
  if (!name) return false;
  if (ts.isIdentifier(name)) return name.text === "confirm";
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.some(element => !ts.isOmittedExpression(element) && bindsName(element.name));
  }
  return false;
}

function declaresInStatements(statements) {
  return statements.some(statement => {
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration => bindsName(declaration.name));
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      return statement.name?.text === "confirm";
    }
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (!clause) return false;
      if (clause.name?.text === "confirm") return true;
      const bindings = clause.namedBindings;
      if (!bindings) return false;
      if (ts.isNamespaceImport(bindings)) return bindings.name.text === "confirm";
      return bindings.elements.some(element => element.name.text === "confirm");
    }
    return false;
  });
}

// Whether this node opens a scope that binds `confirm` itself. A binding the
// check misses only reports a call too many, never one too few.
function scopeBindsConfirm(scope) {
  if (ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)) return declaresInStatements(scope.statements);
  if (ts.isCaseBlock(scope)) return scope.clauses.some(clause => declaresInStatements(clause.statements));
  if (ts.isFunctionLike(scope)) {
    if (scope.parameters?.some(parameter => bindsName(parameter.name))) return true;
    return (ts.isFunctionExpression(scope) || ts.isClassExpression(scope)) && scope.name?.text === "confirm";
  }
  if (ts.isCatchClause(scope)) return bindsName(scope.variableDeclaration?.name);
  if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope))
    && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
    return scope.initializer.declarations.some(declaration => bindsName(declaration.name));
  }
  return false;
}

function isBoundLocally(identifier) {
  for (let scope = identifier.parent; scope; scope = scope.parent) {
    if (scopeBindsConfirm(scope)) return true;
  }
  return false;
}

function isNativeConfirm(expression) {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return node.text === "confirm" && !isBoundLocally(node);
  const name = memberName(node);
  if (name === "confirm") return isGlobalObject(node.expression);
  // `window.confirm.call(window, message)` and friends.
  if (name !== undefined && FORWARDERS.has(name)) return isNativeConfirm(node.expression);
  return false;
}

export function nativeConfirmCalls(text, fileName = "sample.tsx") {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const found = [];
  const visit = node => {
    if (ts.isCallExpression(node) && isNativeConfirm(node.expression)) {
      const start = node.expression.getStart(source);
      found.push({ line: source.getLineAndCharacterOfPosition(start).line + 1, text: `${node.expression.getText(source)}(` });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.sort((a, b) => a.line - b.line);
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE.test(entry.name)) files.push(path);
  }
  return files;
}

test("the matcher finds native confirm calls, prefixed or bare", () => {
  for (const sample of [
    "if (!window.confirm(t(\"library:removeConfirm\"))) return;",
    "if (window . confirm (message)) remove();",
    "const ok = window?.confirm(message);",
    "window.confirm?.(message);",
    "globalThis.confirm(\"Delete?\")",
    "self.confirm(\"Delete?\")",
    "window[\"confirm\"](\"Delete?\")",
    "window['confirm']('Delete?')",
    "window.confirm.call(window, \"Delete?\")",
    "if (!confirm(\"x\")) return;",
    "const ok = await confirm(msg);",
    "(0, confirm)(\"Delete?\")",
    "<button onClick={() => { if (confirm(\"Remove?\")) remove(); }}>Remove</button>",
  ]) assert.equal(nativeConfirmCalls(sample).length, 1, sample);
  assert.deepEqual(nativeConfirmCalls("a();\nb();\nwindow.confirm(x);").map(hit => hit.line), [3]);
  assert.deepEqual(nativeConfirmCalls("a();\nconst ok = await confirm(msg);").map(hit => hit.line), [2]);
});

test("the matcher flags a component that awaits confirm without useConfirm()", () => {
  const withoutHook = [
    "export function RemoveServer({ server }: { server: Server }) {",
    "  const remove = async () => {",
    "    if (!await confirm(t(\"multiplayer:confirmRemove\", { name: server.name }))) return;",
    "    await removeServer(server);",
    "  };",
    "  return <Button onClick={() => void remove()}>Remove</Button>;",
    "}",
  ].join("\n");
  assert.deepEqual(nativeConfirmCalls(withoutHook, "RemoveServer.tsx").map(hit => hit.line), [3]);

  // The hook in one component does not cover a sibling that never called it.
  const siblings = [
    "export function First() {",
    "  const confirm = useConfirm();",
    "  return <Button onClick={async () => { if (await confirm(\"Delete?\")) run(); }}>Delete</Button>;",
    "}",
    "export function Second() {",
    "  return <Button onClick={async () => { if (await confirm(\"Delete?\")) run(); }}>Delete</Button>;",
    "}",
  ].join("\n");
  assert.deepEqual(nativeConfirmCalls(siblings, "Siblings.tsx").map(hit => hit.line), [6]);
});

test("the matcher leaves the awaited dialog and test spies alone", () => {
  for (const sample of [
    "const confirm = useConfirm();",
    "const confirm = useConfirm();\nif (!await confirm(t(\"library:removeConfirm\"), { tone: \"danger\" })) return;",
    "function useRemove() {\n  const confirm = useConfirm();\n  return useCallback(async () => {\n    if (await confirm(\"Delete?\")) run();\n  }, [confirm]);\n}",
    "function run(confirm: ConfirmFn) { return confirm(\"Delete?\"); }",
    "const ask = ({ confirm }: Props) => confirm(\"Delete?\");",
    "const { confirm } = props;\nconfirm(\"Delete?\");",
    "import { confirm } from \"./ask\";\nconfirm(\"Delete?\");",
    "function confirm(message: string) { return Promise.resolve(Boolean(message)); }\nconfirm(\"Delete?\");",
    "vi.spyOn(window, \"confirm\").mockReturnValue(true);",
    "expect(window.confirm).not.toHaveBeenCalled();",
    "const confirmed = window.confirmation;",
    "onConfirm={() => settle(true)}",
    "dialog.confirm(\"Delete?\"); this.confirm(\"Delete?\"); confirmRemove(\"Delete?\");",
    "const api = { confirm(message: string) { return message; } };",
    "// a synchronous `if (!confirm(...))` check always passes\n/* window.confirm(x) */",
    "const hint = \"if (!confirm(x)) return;\";",
  ]) assert.deepEqual(nativeConfirmCalls(sample), [], sample);
});

test("src/ never calls the native confirm", () => {
  const files = sourceFiles(sourceRoot);
  // A wrong root would scan nothing and pass vacuously.
  assert.ok(files.length > 200, `expected the whole src/ tree, found ${files.length} files`);
  const offenders = files.flatMap(file => nativeConfirmCalls(readFileSync(file, "utf8"), file)
    .map(hit => `${relative(root, file).replaceAll("\\", "/")}:${hit.line} ${hit.text}`));
  assert.deepEqual(offenders, [], "Use useConfirm() from src/components/ui/ConfirmDialog.tsx instead:\n" + offenders.join("\n"));
});

test("the awaited confirmation is mounted for the app and used by the converted call sites", () => {
  const app = readFileSync(join(sourceRoot, "app/App.tsx"), "utf8");
  assert.match(app, /<ConfirmProvider>/);
  const users = sourceFiles(sourceRoot)
    .filter(file => !/\.test\.[jt]sx?$/.test(file))
    .filter(file => /\buseConfirm\(\)/.test(readFileSync(file, "utf8")))
    .map(file => relative(sourceRoot, file).replaceAll("\\", "/"))
    .sort();
  for (const file of [
    "features/downloads/DownloadsPage.tsx",
    "features/library/InstanceDetailPage.tsx",
    "features/library/InstanceOverview.tsx",
    "features/library/InstanceSettings.tsx",
    "features/library/ModpackUpdate.tsx",
    "features/library/useInstanceContent.ts",
    "features/library/useWorldDatapacks.ts",
    "features/multiplayer/ServerList.tsx",
  ]) assert.ok(users.includes(file), `${file} should confirm through useConfirm()`);
});
