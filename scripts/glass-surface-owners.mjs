// SPDX-License-Identifier: GPL-3.0-only
import ts from "typescript";

/** Inspect each JSX owner, including unnamed surfaces and complex prop expressions. */
export function glassSurfaceOwners(filename, text) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const owners = [];
  const visit = node => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "GlassSurface") {
      const attribute = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(source) === "className");
      const value = attribute?.initializer;
      const className = value && ts.isStringLiteral(value) ? value.text.trim().split(/\s+/)[0]
        : value && ts.isJsxExpression(value) && value.expression ? `{${value.expression.getText(source).trim()}}` : "";
      owners.push(`${filename}:${className || "<no-className>"}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return owners;
}
