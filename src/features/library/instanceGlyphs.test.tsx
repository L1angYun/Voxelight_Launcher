// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InstanceGlyph,
  glyphLoader,
  glyphLoaderForVersionDirectory,
  glyphVersion,
  type GlyphLoader,
  type GlyphVersion,
} from "./instanceGlyphs";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

function renderGlyph(loader: GlyphLoader, version: GlyphVersion) {
  act(() => root.render(<InstanceGlyph loader={loader} version={version} />));
  return container.querySelector("svg")!;
}

function cells(svg: Element) {
  return [...svg.querySelectorAll("rect")].map(rect => [
    rect.getAttribute("x"),
    rect.getAttribute("y"),
    rect.getAttribute("width"),
    rect.getAttribute("height"),
    rect.getAttribute("fill"),
  ].join(":"));
}

describe("glyphLoader", () => {
  it.each([
    { input: undefined, expected: "vanilla" },
    { input: null, expected: "vanilla" },
    { input: "", expected: "vanilla" },
    { input: "   ", expected: "vanilla" },
    { input: "vanilla", expected: "vanilla" },
    { input: "VANILLA", expected: "vanilla" },
    { input: "none", expected: "vanilla" },
    { input: "fabric", expected: "fabric" },
    { input: "Fabric", expected: "fabric" },
    { input: " quilt ", expected: "quilt" },
    { input: "QUILT", expected: "quilt" },
    { input: "forge", expected: "forge" },
    { input: "Forge", expected: "forge" },
    { input: "neoforge", expected: "neoforge" },
    { input: "NeoForge", expected: "neoforge" },
    { input: "liteloader", expected: "unknown" },
    { input: "optifine", expected: "unknown" },
    { input: "unknown", expected: "unknown" },
  ])("classifies $input as $expected", ({ input, expected }) => {
    expect(glyphLoader(input as string | null | undefined)).toBe(expected);
  });
});

describe("glyphLoaderForVersionDirectory", () => {
  it.each([
    { id: "1.21.1", expected: "vanilla" },
    { id: "fabric-loader-0.16.10-1.21.1", expected: "fabric" },
    { id: "FABRIC-LOADER-0.16.10-1.21.1", expected: "fabric" },
    { id: "quilt-loader-0.26.4-1.21.1", expected: "quilt" },
    { id: "1.20.1-forge-47.2.0", expected: "forge" },
    { id: "forge-1.20.1-47.2.0", expected: "forge" },
    { id: "neoforge-21.1.77", expected: "neoforge" },
    { id: "1.21.1-neoforge-21.1.77", expected: "neoforge" },
    { id: "fabric-1.21.1", expected: "vanilla" },
  ])("classifies version directory $id as $expected", ({ id, expected }) => {
    expect(glyphLoaderForVersionDirectory(id)).toBe(expected);
  });
});

describe("glyphVersion", () => {
  it.each([
    { id: "1.21.1", type: undefined, expected: "release" },
    { id: "1.21.1", type: null, expected: "release" },
    { id: "1.21.1", type: "release", expected: "release" },
    { id: "1.21.1", type: "SNAPSHOT", expected: "snapshot" },
    { id: "1.21.1", type: "old_beta", expected: "old" },
    { id: "1.21.1", type: "OLD_ALPHA", expected: "old" },
    { id: "1.21.1", type: "custom", expected: "release" },
    { id: "24w14a", type: "release", expected: "release" },
    { id: "24w14a", type: undefined, expected: "snapshot" },
    { id: "24W14A", type: undefined, expected: "snapshot" },
    { id: "1.21.5-pre1", type: undefined, expected: "snapshot" },
    { id: "1.21.5-rc-1", type: undefined, expected: "snapshot" },
    { id: "1.21.5 Pre-Release 1", type: undefined, expected: "snapshot" },
    { id: "26.4-snapshot-7", type: undefined, expected: "snapshot" },
    { id: "b1.7.3", type: undefined, expected: "old" },
    { id: "a1.2.6", type: undefined, expected: "old" },
    { id: "c0.30_01c", type: undefined, expected: "old" },
    { id: "inf-20100618", type: undefined, expected: "old" },
    { id: "rd-132211", type: undefined, expected: "old" },
    { id: "b1.7.3", type: "snapshot", expected: "snapshot" },
    { id: "1.21.11-rc-1", type: "release", expected: "release" },
    { id: "15w14a", type: undefined, expected: "snapshot" },
    { id: "1.RV-Pre1", type: undefined, expected: "snapshot" },
    { id: "3D Shareware v1.34", type: undefined, expected: "snapshot" },
    { id: "20w14infinite", type: undefined, expected: "snapshot" },
    { id: "22w13oneblockatatime", type: undefined, expected: "snapshot" },
    { id: "23w13a_or_b", type: undefined, expected: "snapshot" },
    { id: "24w14potato", type: undefined, expected: "snapshot" },
    { id: "25w14craftmine", type: undefined, expected: "snapshot" },
    { id: "fabric-loader-0.16.10-24w14a", type: undefined, expected: "snapshot" },
    { id: "quilt-loader-0.26.4-26.1-snapshot-1", type: undefined, expected: "snapshot" },
    { id: "FABRIC-LOADER-0.16.10-24W14A", type: undefined, expected: "snapshot" },
    { id: "fabric-loader-0.16.10-24w14potato", type: undefined, expected: "snapshot" },
    { id: "fabric-loader-0.16.10-3D Shareware v1.34", type: undefined, expected: "snapshot" },
    { id: "26.1", type: undefined, expected: "release" },
    { id: "26.1-snapshot-1", type: undefined, expected: "snapshot" },
    { id: "26.1-pre-1", type: undefined, expected: "snapshot" },
    { id: "26.1-rc-1", type: undefined, expected: "snapshot" },
    { id: "1.21.1", type: undefined, expected: "release" },
    { id: "", type: undefined, expected: "release" },
  ])("classifies $id with manifest type $type as $expected", ({ id, type, expected }) => {
    expect(glyphVersion(id, type)).toBe(expected);
  });
});

describe("InstanceGlyph", () => {
  it("draws a hidden, crisp, inline 16x16 grid of rect cells", () => {
    const svg = renderGlyph("forge", "snapshot");
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("data-glyph-loader")).toBe("forge");
    expect(svg.getAttribute("data-glyph-version")).toBe("snapshot");
    expect([...svg.children].every(child => child.tagName.toLowerCase() === "rect")).toBe(true);
    const rects = [...svg.querySelectorAll("rect")];
    expect(rects.length).toBeGreaterThan(10);
    for (const rect of rects) {
      const x = Number(rect.getAttribute("x"));
      const y = Number(rect.getAttribute("y"));
      const width = Number(rect.getAttribute("width"));
      const height = Number(rect.getAttribute("height"));
      expect(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(width) && Number.isInteger(height)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(16);
      expect(y + height).toBeLessThanOrEqual(16);
      expect(rect.getAttribute("fill")).toMatch(/^var\(--vx-glyph-/);
    }
  });

  it.each([
    ["vanilla", "fabric"],
    ["fabric", "quilt"],
    ["quilt", "forge"],
    ["forge", "neoforge"],
    ["neoforge", "unknown"],
  ] as const)("draws a different motif for %s and %s", (left, right) => {
    const leftCells = cells(renderGlyph(left, "release"));
    const rightCells = cells(renderGlyph(right, "release"));
    expect(leftCells).not.toEqual(rightCells);
  });

  it("draws a different motif for every loader", () => {
    const loaders: GlyphLoader[] = ["vanilla", "fabric", "quilt", "forge", "neoforge", "unknown"];
    const motifs = loaders.map(loader => JSON.stringify(cells(renderGlyph(loader, "release"))));
    expect(new Set(motifs).size).toBe(loaders.length);
  });

  it("marks snapshots and old versions differently from a release", () => {
    const release = cells(renderGlyph("vanilla", "release"));
    const snapshot = cells(renderGlyph("vanilla", "snapshot"));
    const old = cells(renderGlyph("vanilla", "old"));
    expect(snapshot).not.toEqual(release);
    expect(old).not.toEqual(release);
    expect(old).not.toEqual(snapshot);
    expect(snapshot.length).toBeGreaterThan(release.length);
    expect(old.length).toBeGreaterThan(release.length);
  });

  it.each(["vanilla", "fabric", "quilt", "forge", "neoforge", "unknown"] as const)(
    "keeps %s motif cells and version marks in separate pixels",
    (loader) => {
      const motifCells = occupiedCells(renderGlyph(loader, "release"));
      for (let y = 0; y < 4; y++) {
        for (let x = 12; x < 16; x++) {
          expect(motifCells.has(`${x},${y}`)).toBe(false);
        }
      }
      const snapshot = markSignature(renderGlyph(loader, "snapshot"));
      const old = markSignature(renderGlyph(loader, "old"));
      expect(snapshot.cells.size).toBeGreaterThan(0);
      expect(old.cells.size).toBeGreaterThan(0);
      for (const cell of [...snapshot.cells, ...old.cells]) {
        expect(motifCells.has(cell)).toBe(false);
      }
      expect(snapshot).not.toEqual(old);
      expect(snapshot.fills.has("var(--vx-glyph-mark)")).toBe(true);
      expect(old.fills.has("var(--vx-glyph-mark-old)")).toBe(true);
    },
  );
});

function occupiedCells(svg: Element) {
  const result = new Set<string>();
  for (const rect of svg.querySelectorAll("rect")) {
    const x = Number(rect.getAttribute("x")), y = Number(rect.getAttribute("y"));
    const width = Number(rect.getAttribute("width")), height = Number(rect.getAttribute("height"));
    for (let dx = 0; dx < width; dx++) {
      for (let dy = 0; dy < height; dy++) result.add(`${x + dx},${y + dy}`);
    }
  }
  return result;
}

function markSignature(svg: Element) {
  const cells = new Set<string>();
  const fills = new Set<string>();
  for (const rect of svg.querySelectorAll("rect")) {
    const fill = rect.getAttribute("fill") ?? "";
    if (!/^var\(--vx-glyph-mark(?:-old)?\)$/.test(fill)) continue;
    fills.add(fill);
    const x = Number(rect.getAttribute("x")), y = Number(rect.getAttribute("y"));
    const width = Number(rect.getAttribute("width")), height = Number(rect.getAttribute("height"));
    for (let dx = 0; dx < width; dx++) {
      for (let dy = 0; dy < height; dy++) cells.add(`${x + dx},${y + dy}`);
    }
  }
  return { cells, fills };
}

describe("glyph styles", () => {
  const gridCss = readFileSync("src/features/library/library-grid.css", "utf8");
  const detailCss = readFileSync("src/features/library/instance-detail.css", "utf8");
  const tokensCss = readFileSync("src/design/tokens.css", "utf8");

  it("sizes every glyph at a whole number of 16-cell pixels", () => {
    expect(rule(gridCss, ".vx-instance-glyph")).toMatch(/width:\s*48px;\s*height:\s*48px;/);
    expect(rule(gridCss, ".vx-instance-sheet--list .vx-instance-glyph")).toMatch(/width:\s*32px;\s*height:\s*32px;/);
    expect(rule(detailCss, ".vx-detail-header .vx-instance-glyph")).toMatch(/width:\s*32px;\s*height:\s*32px;/);
  });

  it.each([
    ["dark", ":root {"],
    ["light", '[data-theme="light"] {'],
  ])("keeps the %s glyph shade below its base and its light above", (_theme, scope) => {
    const tokens = colorTokens(tokensCss, scope);
    const block = rule(gridCss, scope === ":root {" ? ".vx-instance-glyph" : '[data-theme="light"] .vx-instance-glyph');
    const base = mixedColor(block, "--vx-glyph-base", tokens);
    const shade = mixedColor(block, "--vx-glyph-shade", tokens);
    const light = mixedColor(block, "--vx-glyph-light", tokens);
    expect(relativeLuminance(light)).toBeGreaterThan(relativeLuminance(base));
    expect(relativeLuminance(base)).toBeGreaterThan(relativeLuminance(shade));
    expect(contrastRatio(base, shade)).toBeGreaterThanOrEqual(1.5);
  });

  it("keeps a high-contrast mark distinct from the ink outline", () => {
    const block = rule(gridCss, '[data-high-contrast="true"] .vx-instance-glyph');
    expect(block).toMatch(/--vx-glyph-mark:\s*var\(--accent-ink/);
    expect(block).toMatch(/--vx-glyph-mark-old:\s*var\(--warning\)/);
  });
});

function rule(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end + 1);
}

function colorTokens(css: string, scope: string) {
  const start = css.indexOf(scope);
  expect(start).toBeGreaterThanOrEqual(0);
  const block = css.slice(start, css.indexOf("\n}", start));
  const result: Record<string, [number, number, number]> = {};
  for (const match of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)) {
    result[match[1]] = hexChannels(match[2]);
  }
  return result;
}

function hexChannels(hex: string): [number, number, number] {
  return [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

function mixedColor(block: string, property: string, tokens: Record<string, [number, number, number]>) {
  const match = new RegExp(`${property}:\\s*color-mix\\(in srgb,\\s*var\\(--([\\w-]+)\\)\\s*(\\d+)%,\\s*var\\(--([\\w-]+)\\)\\)`).exec(block);
  expect(match).not.toBeNull();
  const first = tokens[match![1]], second = tokens[match![3]];
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  const amount = Number(match![2]) / 100;
  return first.map((value, index) => value * amount + second[index] * (1 - amount)) as [number, number, number];
}

function relativeLuminance([red, green, blue]: [number, number, number]) {
  const channel = (value: number) => {
    const unit = value / 255;
    return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrastRatio(first: [number, number, number], second: [number, number, number]) {
  const a = relativeLuminance(first), b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
