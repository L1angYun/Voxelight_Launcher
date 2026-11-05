import ts from "typescript";

const canonical = key => key.replace(":", ".").replace(/_(?:zero|one|two|few|many|other)$/, "");
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Registry data is consumed through translation helpers, not always inline t().
// Keep this finite and derive every key from the actual definitions below.
const registryNamespaces = { navigationRegistry: "common", instanceTabRegistry: "library",
  settingsSectionRegistry: "settings", resourceTypeRegistry: "discover",
  downloadKindRegistry: "downloads", downloadStageRegistry: "downloads" };

/** Qualified constants and scoped templates, including utilities written in TS. */
export function collectTranslationUsage(files, namespaces) {
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX,
    resolveJsonModule: true, esModuleInterop: true, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker(), exact = new Set(), patterns = [], errors = [];
  const namespaceSet = new Set(namespaces);
  const qualified = text => namespaceSet.has(text.split(":")[0]) && text.includes(":");
  function tree(node, depth = 0) {
    if (!node || depth > 12) return undefined;
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return tree(node.expression, depth + 1);
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => ts.isSpreadElement(element) ? tree(element.expression, depth + 1) ?? [] : [tree(element, depth + 1)]);
    if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.flatMap(property => {
      if (ts.isPropertyAssignment(property)) return [[property.name.getText().replace(/^['"]|['"]$/g, ""), tree(property.initializer, depth + 1)]];
      if (ts.isSpreadAssignment(property)) return Object.entries(tree(property.expression, depth + 1) ?? {});
      return [];
    }));
    if (ts.isCallExpression(node) && node.expression.getText() === "createRegistry") return tree(node.arguments[0], depth + 1);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (["filter", "slice", "sort", "enabled"].includes(method)) return tree(node.expression.expression, depth + 1);
      if (node.expression.expression.getText() === "Object" && method === "freeze") return tree(node.arguments[0], depth + 1);
      if (node.expression.expression.getText() === "Object" && method === "values") return Object.values(tree(node.arguments[0], depth + 1) ?? {});
    }
    if (ts.isPropertyAccessExpression(node)) {
      const object = tree(node.expression, depth + 1);
      if (object && typeof object === "object") return object[node.name.text];
    }
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (declaration && ts.isVariableDeclaration(declaration)) return tree(declaration.initializer, depth + 1);
    return undefined;
  }
  function choices(node) {
    const type = checker.getTypeAtLocation(node), union = type.isUnion() ? type.types : [type];
    if (union.every(part => part.isStringLiteral())) return union.map(part => part.value);
    const literal = tree(node);
    if (typeof literal === "string") return [literal];
    // A normal string[] map widens its callback parameter; the finite source
    // array still supplies an auditable set without allowing a whole namespace.
    const properties = []; let base = node;
    while (ts.isPropertyAccessExpression(base)) { properties.unshift(base.name.text); base = base.expression; }
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (!ts.isArrowFunction(parent) && !ts.isFunctionExpression(parent)) continue;
      if (!ts.isIdentifier(base) || parent.parameters[0]?.name.getText() !== base.text) continue;
      const call = parent.parent;
      if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "map") continue;
      const entries = tree(call.expression.expression);
      if (!Array.isArray(entries)) continue;
      const values = entries.map(entry => properties.reduce((value, key) => value?.[key], entry));
      if (values.length && values.every(value => typeof value === "string")) return [...new Set(values)];
    }
    return null;
  }
  for (const filename of files) {
    const source = program.getSourceFile(filename);
    if (!source) continue;
    let defaultNamespace = "common";
    function namespace(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "useTranslation" && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) defaultNamespace = node.arguments[0].text;
      ts.forEachChild(node, namespace);
    }
    namespace(source);
    function visit(node) {
      if (ts.isStringLiteralLike(node) && qualified(node.text)) {
        if (node.parent && ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken && node.text.endsWith("."))
          patterns.push(new RegExp("^" + escape(node.text.replace(":", ".")) + ".*$"));
        else exact.add(canonical(node.text));
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === "labelKey" && ts.isStringLiteralLike(node.initializer)) {
        for (let parent = node.parent; parent; parent = parent.parent) if (ts.isVariableDeclaration(parent)) {
          const ns = registryNamespaces[parent.name.getText(source)];
          if (ns) {
            const value = node.initializer.text;
            exact.add(canonical(value.startsWith(ns + ".") ? value : ns + ":" + value));
            break;
          }
        }
      }
      if (ts.isCallExpression(node) && /^(?:t|i18n\.t|i18next\.t)$/.test(node.expression.getText(source))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument) && !argument.text.includes(":")) exact.add(canonical(`${defaultNamespace}:${argument.text}`));
      }
      if (ts.isTemplateExpression(node) && qualified(node.head.text)) {
        const pieces = node.templateSpans.map(span => choices(span.expression));
        if (pieces.every(Boolean)) {
          let values = [node.head.text];
          for (let index = 0; index < pieces.length; index++) values = values.flatMap(prefix => pieces[index].map(value => prefix + value + node.templateSpans[index].literal.text));
          for (const value of values) exact.add(canonical(value));
        } else if (node.head.text.split(":")[1]) {
          let expression = "^" + escape(node.head.text.replace(":", "."));
          for (const span of node.templateSpans) expression += ".*" + escape(span.literal.text);
          patterns.push(new RegExp(expression + "(?:_(?:zero|one|two|few|many|other))?$"));
        } else {
          errors.push(`Unbounded translation namespace: ${filename}:${source.getLineAndCharacterOfPosition(node.pos).line + 1} ${node.getText(source)}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { exact, patterns, errors, canonical };
}
