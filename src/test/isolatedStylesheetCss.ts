import { parse } from "postcss";

/**
 * jsdom parses @layer but does not apply its declarations in getComputedStyle.
 * Component tests loading ONE stylesheet can unwrap its explicitly ordered
 * outer layers, retaining every rule, conditional and their original order.
 * This does not emulate layer precedence over specificity or !important, or
 * cross-file cascade. Browser acceptance validates those application contracts.
 */
export function isolatedStylesheetCss(css: string, expectedLayers: readonly string[]): string {
  const root = parse(css);
  const layers = root.nodes.filter(node => node.type === "atrule" && node.name === "layer");
  if (layers.length !== expectedLayers.length || !layers.length
    || layers.some((layer, index) => layer.type !== "atrule" || layer.params !== expectedLayers[index] || !layer.nodes)
    || root.nodes.some(node => !layers.includes(node) && node.type !== "comment"))
    throw new Error(`Expected complete stylesheet layers in order: ${expectedLayers.join(", ")}`);
  root.walkAtRules("layer", nested => {
    if (!layers.includes(nested)) throw new Error("Nested cascade layers require browser verification");
  });
  for (const layer of layers) {
    if (layer.type === "atrule") layer.replaceWith(...layer.nodes!);
  }
  return root.toString();
}
