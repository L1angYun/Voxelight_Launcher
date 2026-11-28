// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GLYPH_VIEWBOX,
  InstanceGlyph,
  glyphGeometry,
  glyphLoader,
  glyphLoaderForVersionDirectory,
  glyphVersion,
  type GlyphLoader,
  type GlyphPoint,
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

function faceSignature(svg: Element) {
  return [...svg.querySelectorAll(".vx-instance-glyph__face")].map(face => ({
    tone: face.getAttribute("data-face"),
    points: face.getAttribute("points"),
    fill: face.getAttribute("fill"),
  }));
}

const LOADERS: readonly GlyphLoader[] = ["vanilla", "fabric", "quilt", "forge", "neoforge", "optifine", "unknown"];

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
    { input: "optifine", expected: "optifine" },
    { input: "OptiFine", expected: "optifine" },
    { input: "unknown", expected: "unknown" },
    // A caller may hold the version-directory id rather than the family name.
    { input: "fabric-loader-0.19.3-26.2", expected: "fabric" },
    { input: "26.2-fabric-0.19.3", expected: "fabric" },
    { input: "1.21.1-forge-47.2.0", expected: "forge" },
    { input: "neoforge-21.1.77", expected: "neoforge" },
  ])("classifies $input as $expected", ({ input, expected }) => {
    expect(glyphLoader(input as string | null | undefined)).toBe(expected);
  });
});

describe("glyphLoaderForVersionDirectory", () => {
  it.each([
    { id: "1.21.1", expected: "vanilla" },
    { id: "26.2", expected: "vanilla" },
    { id: "fabric-loader-0.16.10-1.21.1", expected: "fabric" },
    { id: "fabric-loader-0.19.3-26.2", expected: "fabric" },
    { id: "FABRIC-LOADER-0.16.10-1.21.1", expected: "fabric" },
    { id: "26.2-fabric-0.19.3", expected: "fabric" },
    { id: "1.21.1-fabric-0.19.3", expected: "fabric" },
    { id: "26.2-FABRIC-0.19.3", expected: "fabric" },
    { id: "quilt-loader-0.26.4-1.21.1", expected: "quilt" },
    { id: "1.21.1-quilt-0.26.4", expected: "quilt" },
    { id: "1.20.1-forge-47.2.0", expected: "forge" },
    { id: "forge-1.20.1-47.2.0", expected: "forge" },
    { id: "1.21.1-FORGE-52.0.0", expected: "forge" },
    { id: "neoforge-21.1.77", expected: "neoforge" },
    { id: "1.21.1-neoforge-21.1.77", expected: "neoforge" },
    { id: "1.21.1-NeoForge-21.1.77", expected: "neoforge" },
    { id: "1.20.4-OptiFine_HD_U_I7", expected: "optifine" },
    { id: "1.20.4-optifine-1.0", expected: "optifine" },
    { id: "1.20.4-OPTIFINE_HD_U_I7", expected: "optifine" },
    { id: "fabric-1.21.1", expected: "vanilla" },
    { id: "quilt-1.21.1", expected: "vanilla" },
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

describe("glyphGeometry", () => {
  it("draws a centred, whole-pixel isometric cube on a 48-unit grid", () => {
    const geometry = glyphGeometry("release");
    expect(GLYPH_VIEWBOX).toBe(48);
    expect(geometry.faces.map(face => face.tone)).toEqual(["top", "left", "right"]);
    expect(geometry.faces.every(face => face.points.length === 4)).toBe(true);
    expect(geometry.notch).toBeNull();
    expect(geometry.notchEdge).toBeNull();
    expect(geometry.highlights.map(highlight => highlight.tone)).toEqual(["top", "left"]);

    const all = [...geometry.faces.flatMap(face => face.points), ...geometry.dots];
    for (const [x, y] of all) {
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(48);
      expect(y).toBeLessThanOrEqual(48);
    }
    const box = bounds(geometry.faces.flatMap(face => face.points));
    expect(box.width).toBe(36);
    expect(box.height).toBe(32);
    expect(box.left + box.width / 2).toBe(24);
    expect(box.top + box.height / 2).toBe(24);
  });

  it("keeps the top face lightest, then left and right as the two side faces", () => {
    const [top, left, right] = glyphGeometry("release").faces;
    expect(top.tone).toBe("top");
    expect(left.tone).toBe("left");
    expect(right.tone).toBe("right");
    expect(polygonArea(top.points)).toBe(288);
    expect(polygonArea(left.points)).toBe(288);
    expect(polygonArea(right.points)).toBe(288);
    // The side faces meet only at the shared front vertical edge.
    expect(left.points).toContainEqual([24, 24]);
    expect(right.points).toContainEqual([24, 24]);
  });

  it("cuts an exact quarter-size voxel step from the top-front corner for snapshots", () => {
    const release = glyphGeometry("release");
    const snapshot = glyphGeometry("snapshot");
    expect(snapshot.faces.map(face => face.tone)).toEqual(["top", "left", "right"]);
    expect(snapshot.faces[1]).toEqual(release.faces[1]);
    expect(snapshot.faces[2]).toEqual(release.faces[2]);

    const top = snapshot.faces[0];
    expect(top.points).toHaveLength(6);
    expect(polygonArea(top.points)).toBe(polygonArea(release.faces[0].points) - polygonArea(snapshot.notch!));
    expect(polygonArea(snapshot.notch!) * 4).toBe(polygonArea(release.faces[0].points));
    // The quarter is cut from the front corner of the top face.
    expect(bounds(snapshot.notch!).bottom).toBe(24);
    expect(snapshot.notch).toContainEqual([24, 24]);
    expect(snapshot.notchEdge).toEqual([[33, 20], [24, 16], [15, 20]]);
    for (const [x, y] of snapshot.notch!) {
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    }
  });

  it("keeps beta/alpha/classic geometry identical to a release; old is a colour treatment", () => {
    expect(glyphGeometry("old")).toEqual(glyphGeometry("release"));
  });

  it("places a 3x3 lattice of dots on the top face in screen-aligned rows", () => {
    const geometry = glyphGeometry("release");
    expect(geometry.dots).toHaveLength(9);
    expect(new Set(geometry.dots.map(([x, y]) => `${x},${y}`)).size).toBe(9);
    for (const dot of geometry.dots) {
      expect(insidePolygon(dot, geometry.faces[0].points)).toBe(true);
    }
    const rows = new Map<number, number[]>();
    for (const [x, y] of geometry.dots) rows.set(y, [...(rows.get(y) ?? []), x].sort((a, b) => a - b));
    expect([...rows.entries()]).toEqual([
      [11, [24]],
      [13, [18, 30]],
      [16, [12, 24, 36]],
      [19, [18, 30]],
      [21, [24]],
    ]);
    expect(glyphGeometry("snapshot").dots).toEqual(geometry.dots);
  });

  it("insets the one-pixel highlights inside the top and left silhouettes", () => {
    const geometry = glyphGeometry("release");
    const [top, left] = geometry.highlights;
    expect(top.points).toEqual([[7, 16], [24, 9], [41, 16]]);
    expect(left.points).toEqual([[7, 17], [7, 31]]);
    // Every highlight point sits one unit inside the corresponding face edge.
    for (const [x, y] of [...top.points, ...left.points]) {
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
    }
    expect(insidePolygon([7, 16], geometry.faces[0].points)).toBe(true);
    expect(insidePolygon([7, 17], geometry.faces[1].points)).toBe(true);
  });
});

describe("InstanceGlyph", () => {
  it("renders a hidden, crisp, 48-unit cube with a face polygon per tone", () => {
    const svg = renderGlyph("forge", "release");
    expect(svg.getAttribute("viewBox")).toBe("0 0 48 48");
    expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.getAttribute("data-glyph-loader")).toBe("forge");
    expect(svg.getAttribute("data-glyph-version")).toBe("release");
    expect(faceSignature(svg)).toEqual([
      { tone: "top", points: "24,8 42,16 24,24 6,16", fill: "var(--vx-glyph-face-top)" },
      { tone: "left", points: "6,16 24,24 24,40 6,32", fill: "var(--vx-glyph-face-left)" },
      { tone: "right", points: "24,24 42,16 42,32 24,40", fill: "var(--vx-glyph-face-right)" },
    ]);
    for (const face of svg.querySelectorAll<SVGPolygonElement>(".vx-instance-glyph__face")) {
      for (const pair of face.getAttribute("points")!.split(" ")) {
        expect(pair.split(",").every(value => Number.isInteger(Number(value)))).toBe(true);
      }
    }
  });

  it("draws the 3x3 dotted lattice in the darkest face tone at 35% opacity", () => {
    const svg = renderGlyph("fabric", "release");
    const dots = [...svg.querySelectorAll<SVGRectElement>("rect.vx-instance-glyph__dot")];
    expect(dots).toHaveLength(9);
    for (const dot of dots) {
      expect(dot.getAttribute("fill")).toBe("var(--vx-glyph-dot)");
      expect(Number(dot.getAttribute("fill-opacity"))).toBeCloseTo(0.35);
      expect(Number(dot.getAttribute("width"))).toBe(2);
      expect(Number(dot.getAttribute("height"))).toBe(2);
    }
  });

  it("paints the dotted lattice above the faces but below the snapshot notch", () => {
    const release = [...renderGlyph("vanilla", "release").children];
    const firstDot = release.findIndex(child => child.classList.contains("vx-instance-glyph__dot"));
    const lastFace = release.reduce((last, child, index) =>
      child.classList.contains("vx-instance-glyph__face") ? index : last, -1);
    expect(firstDot).toBeGreaterThan(lastFace);

    const snapshot = [...renderGlyph("vanilla", "snapshot").children];
    const notch = snapshot.findIndex(child => child.classList.contains("vx-instance-glyph__notch"));
    const lastSnapshotDot = snapshot.reduce((last, child, index) =>
      child.classList.contains("vx-instance-glyph__dot") ? index : last, -1);
    expect(notch).toBeGreaterThan(lastSnapshotDot);
  });

  it("gives the top and left faces a one-pixel inner highlight", () => {
    const svg = renderGlyph("vanilla", "release");
    const highlights = [...svg.querySelectorAll<SVGPolylineElement>(".vx-instance-glyph__highlight")];
    expect(highlights.map(line => line.getAttribute("data-highlight"))).toEqual(["top", "left"]);
    for (const line of highlights) {
      expect(line.getAttribute("stroke-width")).toBe("1");
      expect(line.getAttribute("stroke")).toMatch(/^var\(--vx-glyph-highlight-(?:top|left)\)$/);
      expect(line.getAttribute("vector-effect")).toBe("non-scaling-stroke");
      expect(line.getAttribute("fill")).toBe("none");
    }
  });

  it("renders the snapshot notch and the release cube without one", () => {
    const release = renderGlyph("quilt", "release");
    expect(release.querySelector(".vx-instance-glyph__notch")).toBeNull();
    const snapshot = renderGlyph("quilt", "snapshot");
    const notch = snapshot.querySelector<SVGPolygonElement>(".vx-instance-glyph__notch");
    expect(notch).not.toBeNull();
    expect(notch!.getAttribute("points")).toBe("24,24 33,20 24,16 15,20");
    expect(notch!.getAttribute("fill")).toBe("var(--vx-glyph-notch)");
    expect(snapshot.querySelector(".vx-instance-glyph__notch-edge")).not.toBeNull();
  });

  it("keeps old versions geometrically identical to releases", () => {
    expect(faceSignature(renderGlyph("optifine", "old"))).toEqual(faceSignature(renderGlyph("optifine", "release")));
    expect(renderGlyph("optifine", "old").querySelector(".vx-instance-glyph__notch")).toBeNull();
  });

  it("keeps one cube identity for every loader; the loader only selects a colour token", () => {
    const signatures = LOADERS.map(loader => ({
      loader: renderGlyph(loader, "release").getAttribute("data-glyph-loader"),
      faces: faceSignature(renderGlyph(loader, "release")),
    }));
    expect(new Set(signatures.map(entry => JSON.stringify(entry.faces))).size).toBe(1);
    expect(signatures.map(entry => entry.loader)).toEqual(LOADERS);
  });
});

describe("glyph styles", () => {
  const gridCss = readFileSync("src/features/library/library-grid.css", "utf8");
  const detailCss = readFileSync("src/features/library/instance-detail.css", "utf8");
  const tokensCss = readFileSync("src/design/tokens.css", "utf8");

  it("sizes every glyph at a whole pixel count", () => {
    expect(rule(gridCss, ".vx-instance-glyph")).toMatch(/width:\s*48px;\s*height:\s*48px;/);
    expect(rule(gridCss, ".vx-instance-sheet--list .vx-instance-glyph")).toMatch(/width:\s*32px;\s*height:\s*32px;/);
    expect(rule(detailCss, ".vx-detail-header .vx-instance-glyph")).toMatch(/width:\s*32px;\s*height:\s*32px;/);
  });

  it.each([
    ["dark", ".vx-instance-glyph"],
    ["light", '[data-theme="light"] .vx-instance-glyph'],
  ])("defines a base hue token for every loader in the %s theme", (_theme, selector) => {
    const block = rule(gridCss, selector);
    for (const token of [...LOADERS, "old"]) {
      expect(block).toMatch(new RegExp(`--vx-glyph-${token}:\\s*#[0-9a-f]{6}`, "i"));
    }
  });

  it("maps every loader and the old kind to its own base token", () => {
    for (const loader of LOADERS) {
      const block = rule(gridCss, `.vx-instance-glyph[data-glyph-loader="${loader}"]`);
      expect(block).toMatch(new RegExp(`--vx-glyph-base:\\s*var\\(--vx-glyph-${loader}\\)`));
    }
    expect(rule(gridCss, '.vx-instance-glyph[data-glyph-version="old"]'))
      .toMatch(/--vx-glyph-base:\s*var\(--vx-glyph-old\)/);
  });

  it("derives all three face tones from the loader base with color-mix, never a hard-coded face", () => {
    const block = rule(gridCss, ".vx-instance-glyph");
    expect(faceMix(block, "top")).toEqual({ percent: 55, other: "white" });
    expect(faceMix(block, "left")).toEqual({ percent: 85, other: "white" });
    expect(faceMix(block, "right")).toEqual({ percent: 70, other: "black" });
    const faces = block.match(/--vx-glyph-face-[\w-]+:\s*color-mix\([^;]+;/g) ?? [];
    expect(faces).toHaveLength(3);
    for (const face of faces) {
      expect(face).toContain("var(--vx-glyph-base)");
      expect(face).toMatch(/color-mix\(in srgb,/);
      expect(face).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
    expect(block).toMatch(/--vx-glyph-dot:\s*var\(--vx-glyph-face-right\)/);
    expect(block).toMatch(/--vx-glyph-highlight-top:\s*color-mix\(in srgb, var\(--vx-glyph-face-top\) 55%, white\)/);
    expect(block).toMatch(/--vx-glyph-highlight-left:\s*color-mix\(in srgb, var\(--vx-glyph-face-left\) 55%, white\)/);
    expect(block).toMatch(/--vx-glyph-notch:\s*color-mix\(in srgb, var\(--vx-glyph-face-right\) 62%, black\)/);
  });

  it.each([
    ["dark", ".vx-instance-glyph", ":root {"],
    ["light", '[data-theme="light"] .vx-instance-glyph', '[data-theme="light"] {'],
  ])("keeps every %s darkest face at least 3:1 against the card surface", (_theme, selector, scope) => {
    const block = rule(gridCss, selector);
    const baseBlock = rule(gridCss, ".vx-instance-glyph");
    const bases = hexTokens(block);
    const surface = hexTokens(colorTokens(tokensCss, scope))["--surface-card"];
    expect(surface).toBeDefined();
    const rightMix = faceMix(baseBlock, "right");
    expect(rightMix.other).toBe("black");
    for (const token of [...LOADERS, "old"]) {
      const base = bases[`--vx-glyph-${token}`];
      expect(base).toBeDefined();
      const right = mix(base, [0, 0, 0], rightMix.percent / 100);
      expect(contrastRatio(right, surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it.each([
    [".vx-instance-glyph"],
    ['[data-theme="light"] .vx-instance-glyph'],
  ])("orders the faces top-lightest, left-mid, right-darkest for every base", (selector) => {
    const baseBlock = rule(gridCss, ".vx-instance-glyph");
    const bases = hexTokens(rule(gridCss, selector));
    const topMix = faceMix(baseBlock, "top");
    const leftMix = faceMix(baseBlock, "left");
    const rightMix = faceMix(baseBlock, "right");
    for (const token of [...LOADERS, "old"]) {
      const base = bases[`--vx-glyph-${token}`];
      expect(base).toBeDefined();
      const top = mixWith(base, topMix);
      const left = mixWith(base, leftMix);
      const right = mixWith(base, rightMix);
      expect(relativeLuminance(top)).toBeGreaterThan(relativeLuminance(left));
      expect(relativeLuminance(left)).toBeGreaterThan(relativeLuminance(right));
    }
  });

  it("keeps the high-contrast override wired to the base token", () => {
    const block = rule(gridCss, '[data-high-contrast="true"] .vx-instance-glyph');
    expect(block).toMatch(/--vx-glyph-base:\s*var\(--text-primary\)/);
  });

  it.each([
    ["dark", ":root {"],
    ["light", '[data-theme="light"] {'],
  ])("keeps the high-contrast %s darkest face at least 3:1 against the panel surface", (_theme, scope) => {
    const tokens = hexTokens(colorTokens(tokensCss, scope));
    const base = tokens["--text-primary"];
    const surface = tokens["--surface-solid"];
    expect(base).toBeDefined();
    expect(surface).toBeDefined();
    const rightMix = faceMix(rule(gridCss, ".vx-instance-glyph"), "right");
    expect(contrastRatio(mix(base, [0, 0, 0], rightMix.percent / 100), surface)).toBeGreaterThanOrEqual(3);
  });

  it("removes the dotted lattice and corner bracket behind a voxel glyph", () => {
    expect(gridCss).toMatch(
      /\.vx-instance-identity\[data-identity-face="glyph"\]::before,\s*\.vx-instance-identity\[data-identity-face="glyph"\]::after\s*\{[^}]*content:\s*none/,
    );
  });
});

function bounds(points: readonly GlyphPoint[]) {
  const xs = points.map(([x]) => x), ys = points.map(([, y]) => y);
  const left = Math.min(...xs), right = Math.max(...xs);
  const top = Math.min(...ys), bottom = Math.max(...ys);
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

function polygonArea(points: readonly GlyphPoint[]) {
  let area = 0;
  for (let index = 0; index < points.length; index++) {
    const [x, y] = points[index], [nextX, nextY] = points[(index + 1) % points.length];
    area += x * nextY - nextX * y;
  }
  return Math.abs(area) / 2;
}

function insidePolygon([x, y]: GlyphPoint, points: readonly GlyphPoint[]) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const [xi, yi] = points[index], [xj, yj] = points[previous];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

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
  return css.slice(start, css.indexOf("\n}", start));
}

function hexTokens(block: string) {
  const result: Record<string, [number, number, number]> = {};
  for (const match of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)) {
    result[`--${match[1]}`] = hexChannels(match[2]);
  }
  return result;
}

function faceMix(block: string, tone: "top" | "left" | "right") {
  const match = new RegExp(
    `--vx-glyph-face-${tone}:\\s*color-mix\\(in srgb,\\s*var\\(--vx-glyph-base\\)\\s*(\\d+)%,\\s*(white|black)\\)`,
  ).exec(block);
  expect(match).not.toBeNull();
  return { percent: Number(match![1]), other: match![2] as "white" | "black" };
}

function mixWith(base: [number, number, number], face: { percent: number; other: "white" | "black" }) {
  const other: [number, number, number] = face.other === "white" ? [255, 255, 255] : [0, 0, 0];
  return mix(base, other, face.percent / 100);
}

function mix(first: [number, number, number], second: [number, number, number], amount: number): [number, number, number] {
  return first.map((value, index) => value * amount + second[index] * (1 - amount)) as [number, number, number];
}

function hexChannels(hex: string): [number, number, number] {
  return [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
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
