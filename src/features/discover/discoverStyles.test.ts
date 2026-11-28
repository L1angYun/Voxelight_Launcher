import { readFileSync } from "node:fs";
import { parse } from "postcss";
import { describe, expect, it } from "vitest";

// Geometry contracts of discover.css that jsdom cannot lay out: they are checked
// against the declared values, resolved through the design tokens.
const discover = parse(readFileSync("src/features/discover/discover.css", "utf8"));
const tokens = readFileSync("src/design/tokens.css", "utf8");

function token(name: string): number {
  const start = tokens.indexOf(`${name}:`);
  const match = start < 0 ? null : tokens.slice(start + name.length + 1).match(/^\s*(-?\d+(?:\.\d+)?)px\s*;/);
  if (!match) throw new Error(`No px value for ${name}`);
  return Number(match[1]);
}

/** Resolves `0`, `4px`, `var(--x)`, `calc(var(--x) + var(--y))` and `calc(var(--x) * -1)` to px. */
function px(value: string): number {
  const number = (text: string) => {
    const match = text.match(/^(-?\d+(?:\.\d+)?)(?:px)?$/);
    if (!match) throw new Error(`Cannot resolve ${value}`);
    return Number(match[1]);
  };
  const resolved = value.trim().replace(/var\((--[\w-]+)\)/g, (_, name: string) => `${token(name)}px`);
  const parts = resolved.replace(/^calc\((.*)\)$/, "$1").split(/\s+([+*-])\s+/);
  let total = number(parts[0]);
  for (let index = 1; index < parts.length; index += 2) {
    const operand = number(parts[index + 1]);
    total = parts[index] === "+" ? total + operand : parts[index] === "-" ? total - operand : total * operand;
  }
  return total;
}

function declarations(selector: string): Record<string, string> {
  const found: Record<string, string>[] = [];
  discover.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    const values: Record<string, string> = {};
    rule.walkDecls(declaration => { values[declaration.prop] = declaration.value; });
    found.push(values);
  });
  expect(found, selector).toHaveLength(1);
  return found[0];
}

describe("install target rows", () => {
  it("draw the keyboard focus ring outside the dotted selected frame (spec 2.9)", () => {
    // LatticeFrame sits at inset -lattice-outset with a 2px border drawn inwards:
    // the selected frame covers 1-3px outside the row.
    const frameOuterEdge = token("--lattice-outset");
    const ring = declarations(".vx-install-target__row:focus-visible");
    const inner = px(ring["outline-offset"]);
    expect(inner).toBeGreaterThan(frameOuterEdge);
    // The same 4-6px band as a focused LatticeFrame.
    expect(inner).toBe(token("--focus-ring-offset") + token("--focus-ring-width"));
  });
});

describe("install target dialog and details drawer", () => {
  const dialogs = ".vx-dialog:is(.vx-install-target, .vx-project-details)";

  it("keep the footer action in view by scrolling only the body", () => {
    const open = declarations(`${dialogs}[open]`);
    expect(open.display).toBe("flex");
    expect(open["flex-direction"]).toBe("column");
    const body = declarations(`${dialogs} > .vx-dialog__body`);
    expect(body["min-height"]).toBe("0");
  });

  it("give the scrolling body room for the lattice frames and focus rings it would clip", () => {
    const body = declarations(`${dialogs} > .vx-dialog__body`);
    const [, inline, bottom] = body.padding.split(/\s+/);
    const ring = declarations(".vx-install-target__row:focus-visible");
    const ringOuterEdge = px(ring["outline-offset"]) + token("--focus-ring-width");
    expect(px(inline)).toBeGreaterThanOrEqual(ringOuterEdge);
    expect(px(bottom)).toBeGreaterThanOrEqual(ringOuterEdge);
    // The room is taken from the dialog padding, so the content does not move.
    expect(px(body["margin-inline"])).toBe(-px(inline));
    expect(px(body["margin-bottom"])).toBe(-px(bottom));
  });
});
