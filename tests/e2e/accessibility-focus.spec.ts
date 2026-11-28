// SPDX-License-Identifier: GPL-3.0-only
import { chromium, expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { installLauncherFixture } from "./fixtures";
import { decodePng } from "./helpers/glass-pixel-probe.mjs";
import { focusEdgeSamples } from "./helpers/focus-edge-sampling";
import { captureFocusFrame, installFocusHaloPaintProbe } from "./helpers/focus-halo-capture";
import { referenceAttempts } from "./helpers/focus-reference-attempts";

const nativeTest = test.extend({
  context: async ({ baseURL }, use) => {
    const browser = await chromium.launch({ channel: "chromium", args: ["--use-angle=d3d11"] });
    const context = await browser.newContext({ baseURL, deviceScaleFactor: 1 });
    try { await use(context); } finally { await context.close(); await browser.close(); }
  },
});

nativeTest.afterEach(async ({ page }, info) => {
  const runtime = await page.evaluate(() => {
    const world = document.querySelector<HTMLElement>(".world-scene");
    const gl = world?.querySelector("canvas")?.getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: debug ? String(gl!.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null,
      dpr: devicePixelRatio, theme: document.documentElement.dataset.theme,
      effects: document.documentElement.dataset.effects, world: { ...world?.dataset } };
  });
  await writeFile(info.outputPath("browser-runtime.json"), JSON.stringify(runtime, null, 2));
  expect(runtime.renderer).toMatch(/Direct3D11|D3D11/);
  expect(runtime.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  expect(runtime.dpr).toBe(1);
  expect(runtime.theme).toBe("light");
});

function contrast(first: readonly number[], second: readonly number[]) {
  const luminance = (rgb: readonly number[]) => rgb.map(value => {
    const s = value / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

function readKeyboardStation() {
  const active = document.activeElement as HTMLElement | null;
  const css = active ? getComputedStyle(active) : null;
  // R9 spec §3.2: a flat select paints its single field ring on its surface,
  // and the create dialog's version list on its well, not on the focused
  // element itself; read the ring where it is painted.
  const owner = active?.closest(".vx-launch-console__selector-wrap")
    ?? active?.closest(".vx-select--flat")?.querySelector(":scope > .vx-select__surface")
    ?? active?.closest(".vx-create-version-well")
    ?? active?.closest(".vx-search,.vx-discover-search,.vx-select")
    ?? active?.closest(".vx-instance-card")?.querySelector(":scope > .vx-lattice-frame") ?? active;
  const ownerCss = owner ? getComputedStyle(owner) : null;
  const probe = document.createElement("span"); probe.style.color = "var(--accent-indicator)";
  document.body.append(probe);
  const indicatorColor = getComputedStyle(probe).color; probe.remove();
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  const rgba = (color: string) => {
    context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
    return [...context.getImageData(0, 0, 1, 1).data];
  };
  const halo = document.querySelector<HTMLCanvasElement>(".vx-cursor-halo");
  // R9 spec §3.2 single field ring: "0 0 0 1px <indicator>" computes as "<color> 0px 0px 0px 1px".
  // A ring layer is a solid spread: no offset and no blur. The library sort menu
  // draws its inner ring pixel with an inset layer of that kind instead of a border.
  // Every layer is counted, parsed or not, so a second halo or spread layer
  // (or one this parser cannot read) breaks the single ring.
  const shadowSource = !ownerCss || ownerCss.boxShadow === "none" ? [] : ownerCss.boxShadow.split(/,(?![^(]*\))/);
  const shadowLayers = shadowSource
    .map(layer => /^(.+?) (-?\d+(?:\.\d+)?)px (-?\d+(?:\.\d+)?)px (\d+(?:\.\d+)?)px (-?\d+(?:\.\d+)?)px( inset)?$/.exec(layer.trim()))
    .flatMap(match => match ? [{ color: match[1], x: Number(match[2]), y: Number(match[3]), blur: Number(match[4]),
      spread: Number(match[5]), inset: Boolean(match[6]) }] : []);
  const ringLayer = (inset: boolean) => shadowLayers.find(layer => layer.inset === inset
    && layer.x === 0 && layer.y === 0 && layer.blur === 0 && layer.spread > 0) ?? null;
  const fieldRing = ringLayer(false), insetRing = ringLayer(true);
  return { at: performance.now(), tag: active?.tagName, id: active?.id, className: active?.className,
    label: active?.getAttribute("aria-label"), text: active?.textContent?.trim().slice(0, 120),
    focusVisible: active?.matches(":focus-visible"), outlineColor: css?.outlineColor,
    outlineStyle: css?.outlineStyle, outlineWidth: css?.outlineWidth, borderColor: css?.borderTopColor,
    activeVisible: active?.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
    activeBounds: active?.getBoundingClientRect().toJSON(),
    owner: owner?.className, ownerOutlineColor: ownerCss?.outlineColor,
    ownerOutlineStyle: ownerCss?.outlineStyle, ownerOutlineWidth: ownerCss?.outlineWidth,
    ownerOutlineOffset: ownerCss?.outlineOffset, ownerOutlineRgba: rgba(ownerCss?.outlineColor ?? "transparent"),
    ownerBorderWidth: ownerCss?.borderTopWidth, ownerBorderRgba: rgba(ownerCss?.borderTopColor ?? "transparent"),
    ownerBoxShadow: ownerCss?.boxShadow, fieldRingRgba: fieldRing ? rgba(fieldRing.color) : null,
    fieldRingSpread: fieldRing ? fieldRing.spread : null,
    insetRingRgba: insetRing ? rgba(insetRing.color) : null, insetRingSpread: insetRing ? insetRing.spread : null,
    shadowLayerCount: shadowSource.length,
    ownerRadius: ownerCss ? parseFloat(ownerCss.borderTopLeftRadius) || 0 : 0,
    ownerVisible: (owner as HTMLElement | null)?.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
    bounds: owner?.getBoundingClientRect().toJSON(), indicatorColor, indicatorRgba: rgba(indicatorColor),
    halo: halo ? { state: halo.dataset.haloState, opacity: getComputedStyle(halo).opacity } : null };
}

type KeyboardStation = ReturnType<typeof readKeyboardStation>;

// R9 spec §3.2: a field's single focus ring is its 1px indicator border plus a
// 1px --field-focus shadow; its transparent -2px outline only serves forced
// colors. Such a station is measured just outside that shadow.
const fieldRingStation = (value: KeyboardStation) => value.ownerOutlineStyle !== "none"
  && parseFloat(value.ownerOutlineWidth!) > 0 && value.ownerOutlineRgba[3] === 0;
// The painted field ring runs from its inner edge (border, or inset layer) to
// the outer end of its spread.
const ringEdgeWidth = (value: KeyboardStation) => parseFloat(value.ownerBorderWidth ?? "0") || (value.insetRingSpread ?? 0);
const stationRing = (value: KeyboardStation) => fieldRingStation(value) && value.fieldRingSpread !== null
  ? { offset: "0px", width: value.fieldRingSpread + "px",
    ring: { inner: ringEdgeWidth(value), outer: value.fieldRingSpread, radius: value.ownerRadius } }
  : { offset: value.ownerOutlineOffset!, width: value.ownerOutlineWidth! };
type VisitedStation = KeyboardStation & { after?: KeyboardStation; edges?: ReturnType<typeof focusEdgeSamples>;
  ring?: ReturnType<typeof paintedRingBand> | null;
  screenshot?: string; haloCapture?: Awaited<ReturnType<typeof captureFocusFrame>>["haloCapture"];
  referenceCapture?: Awaited<ReturnType<typeof captureFocusFrame>>["referenceCapture"]; backgroundAttempts?: unknown[] };

type Bounds = { left: number; right: number; top: number; bottom: number };
type RingBand = { inner: number; outer: number; radius: number };
type SampleGeometry = { bounds: Bounds; offset: string; width: string; foreground: number[]; ring?: RingBand };
type CapturedImage = { width: number; height: number; pixels: Uint8Array };

/**
 * The field ring's own pixels: every column fully inside the band from the
 * inner edge to the end of the spread, on the straight left and right runs
 * between the rounded corners. A pixel the cursor halo painted is read from
 * the halo-hidden reference, so only the CSS ring is measured.
 */
function paintedRingBand(image: CapturedImage, bounds: Bounds, ring: RingBand, foreground: readonly number[],
  haloPaint: CapturedImage, referenceImage: CapturedImage) {
  const span = (from: number, to: number) => Array.from({ length: Math.max(0, Math.floor(to) - Math.ceil(from)) }, (_, i) => Math.ceil(from) + i);
  const rows = span(bounds.top + ring.radius, bounds.bottom - ring.radius);
  return [{ side: "left", xs: span(bounds.left - ring.outer, bounds.left + ring.inner) },
    { side: "right", xs: span(bounds.right - ring.inner, bounds.right + ring.outer) }].map(({ side, xs }) => {
    const columns = xs.map(x => {
      const pixels = rows.map(y => {
        const at = (y * image.width + x) * 4, source = haloPaint.pixels[at + 3] > 0 ? referenceImage : image;
        return Array.from(source.pixels.subarray(at, at + 3));
      });
      const median = [0, 1, 2].map(channel => pixels.map(rgb => rgb[channel]).sort((a, b) => a - b)[Math.floor(pixels.length / 2)]);
      return { x, rows: rows.length, median, maxDelta: Math.max(...median.map((value, index) => Math.abs(value - foreground[index]))) };
    });
    return { side, columns, maxDelta: columns.length ? Math.max(...columns.map(column => column.maxDelta)) : null };
  });
}

async function sampleAdjacentFocus<T>(page: Page, screenshot: string, initial: T, read: () => Promise<T>,
  geometry: (value: T) => SampleGeometry, identity: (value: T) => unknown) {
  const { result, attempts } = await referenceAttempts(async attempt => {
    const before = attempt === 0 ? initial : await read();
    const currentScreenshot = attempt === 0 ? screenshot : screenshot.replace(/\.png$/, ".retry-1.png");
    const g = geometry(before);
    const { image, referenceImage, haloPaint, haloCapture, referenceCapture } = await captureFocusFrame(page,
      currentScreenshot, g.bounds, g.offset, g.width);
    const after = await read();
    const edges = focusEdgeSamples(image, g.bounds, g.offset, g.width, g.foreground, haloPaint, referenceImage);
    const ring = g.ring ? paintedRingBand(image, g.bounds, g.ring, g.foreground, haloPaint, referenceImage) : null;
    const record = { before, after, edges, ring, screenshot: currentScreenshot, haloCapture, referenceCapture };
    await writeFile(currentScreenshot.replace(/\.png$/, ".sampling.json"), JSON.stringify(record, null, 2));
    // Ring width/color belong to the normal frame. The existing halo can
    // suppress the native outline later; that reference-time CSS is not a
    // second measurement of the normal ring. Its layout and focus must hold.
    expect(geometry(after).bounds, currentScreenshot + " normal/reference bounds").toEqual(g.bounds);
    expect(identity(after), currentScreenshot + " focus retained").toEqual(identity(before));
    return record;
  });
  return { ...result, backgroundAttempts: attempts.map((attempt, index) => {
    const deltas = attempt.edges.flatMap(edge => edge.maxBackgroundDelta === null ? [] : [edge.maxBackgroundDelta]);
    return { index, screenshot: attempt.screenshot, referenceScreenshot: attempt.referenceCapture.screenshot,
      samplingEvidence: attempt.screenshot.replace(/\.png$/, ".sampling.json"),
      replacedCount: attempt.edges.reduce((sum, edge) => sum + edge.replacedCount, 0),
      backgroundCheckApplies: attempt.edges.some(edge => edge.backgroundCheckApplies),
      maxBackgroundDelta: deltas.length ? Math.max(...deltas) : null,
      backgroundWithinTolerance: attempt.edges.every(edge => edge.backgroundWithinTolerance),
      backgroundStable: attempt.edges.every(edge => edge.backgroundStable),
      retryReason: attempt.edges.some(edge => edge.invalidReason === "background-frame-drift") ? "background-frame-drift" : null,
    };
  }) };
}

async function tabTo(page: Page, target: Locator, evidence?: { info: TestInfo; path: string }) {
  const visited: VisitedStation[] = [];
  for (let index = 0; index < 60; index++) {
    await page.keyboard.press("Tab");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const initial = await page.evaluate(readKeyboardStation);
    if (evidence) {
      const name = evidence.path + "-tab-" + String(index).padStart(2, "0");
      expect(initial.bounds, name).toBeTruthy();
      const screenshot = evidence.info.outputPath(name + ".png");
      const captured = await sampleAdjacentFocus(page, screenshot, initial, () => page.evaluate(readKeyboardStation), value => ({
        bounds: value.bounds!, ...stationRing(value), foreground: value.indicatorRgba.slice(0, 3),
      }), value => [value.tag, value.id, value.label, value.focusVisible]);
      const { before, after, ...details } = captured;
      const { edges, ring } = captured;
      const station = { ...before, after, ...details };
      visited.push(station);
      await writeFile(evidence.info.outputPath(name + ".json"), JSON.stringify(station, null, 2));
      expect.soft(before.activeVisible, name).toBe(true);
      expect.soft(before.ownerVisible, name).toBe(true);
      expect.soft(before.focusVisible, name).toBe(true);
      expect.soft(before.bounds!.width, name).toBeGreaterThan(0);
      expect.soft(before.bounds!.height, name).toBeGreaterThan(0);
      expect.soft(after.bounds, name + " screenshot geometry").toEqual(before.bounds);
      expect.soft([after.tag, after.id, after.label], name + " focus retained").toEqual([before.tag, before.id, before.label]);
      expect.soft(after.indicatorRgba, name).toEqual(before.indicatorRgba);
      for (const sample of [before, after]) if (sample.ownerOutlineStyle !== "none" && parseFloat(sample.ownerOutlineWidth!) > 0) {
        if (fieldRingStation(sample)) {
          expect.soft([sample.ownerOutlineWidth, sample.ownerOutlineOffset], name + " forced-colors fallback outline").toEqual(["2px", "-2px"]);
          if (sample.ownerBorderWidth !== "0px") {
            expect.soft(sample.ownerBorderRgba, name + " single ring border").toEqual(sample.indicatorRgba);
            expect.soft(sample.ownerBorderWidth, name + " single ring border").toBe("1px");
          } else {
            // The library sort menu matches the 38px search field: border 0,
            // its inner ring pixel is an inset 1px indicator layer.
            expect.soft(sample.insetRingRgba, name + " single ring inset edge").toEqual(sample.indicatorRgba);
            expect.soft(sample.insetRingSpread, name + " single ring inset edge").toBe(1);
          }
          expect.soft(sample.fieldRingRgba, name + " single ring shadow").toEqual(sample.indicatorRgba);
          expect.soft(sample.fieldRingSpread, name + " single ring shadow").toBe(1);
          // Nothing else may be layered on the ring: only the outer spread, and
          // the inset edge when there is no border.
          expect.soft(sample.shadowLayerCount, name + " single ring shadow layers")
            .toBe(1 + (sample.ownerBorderWidth === "0px" ? 1 : 0));
        } else expect.soft(sample.ownerOutlineRgba, name + " visible CSS outline").toEqual(sample.indicatorRgba);
      }
      // A flat select surface and the version well paint only a field ring, so
      // each must be one: border or inset edge, spread, and the fallback outline.
      if (/(?:^|\s)(?:vx-select__surface|vx-create-version-well)(?:\s|$)/.test(String(before.owner ?? "")))
        expect.soft(fieldRingStation(before) && before.fieldRingSpread !== null, name + " field ring owner").toBe(true);
      // A field ring is painted, not only declared: its 2px band (inner edge
      // plus spread) reads as the indicator on both straight sides.
      if (fieldRingStation(before)) {
        expect.soft(ring, name + " painted ring sampled").not.toBeNull();
        for (const side of ring ?? []) {
          expect.soft(side.columns.length, name + "/" + side.side + " painted ring columns").toBeGreaterThan(0);
          expect.soft(side.columns.every(column => column.rows > 0), name + "/" + side.side + " painted ring rows").toBe(true);
          expect.soft(side.maxDelta, name + "/" + side.side + " painted ring is the indicator").toBeLessThanOrEqual(8);
        }
      }
      for (const edge of edges) {
        expect.soft(edge.valid, name + "/" + edge.side + " complete adjacent edge").toBe(true);
        expect.soft(edge.ratio, name + "/" + edge.side + " median contrast").not.toBeNull();
        if (edge.ratio !== null) expect.soft(edge.ratio, name + "/" + edge.side).toBeGreaterThanOrEqual(3);
      }
    } else visited.push(initial);
    if (await target.evaluate(element => element === document.activeElement)) return visited;
  }
  throw new Error("Keyboard could not reach target: " + JSON.stringify(visited));
}

async function outline(owner: Locator) {
  return owner.evaluate(element => {
    const style = getComputedStyle(element), root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span"); probe.style.color = "var(--accent-indicator)";
    document.body.append(probe);
    const indicatorColor = getComputedStyle(probe).color; probe.remove();
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = style.outlineColor; context.fillRect(0, 0, 1, 1);
    const rgba = [...context.getImageData(0, 0, 1, 1).data], rgb = rgba.slice(0, 3);
    context.fillStyle = indicatorColor; context.fillRect(0, 0, 1, 1);
    const indicatorRgba = [...context.getImageData(0, 0, 1, 1).data];
    const fieldRing = /^(rgba?\([^)]*\)) 0px 0px 0px (\d+(?:\.\d+)?)px$/.exec(style.boxShadow);
    return { outlineColor: style.outlineColor, outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth, outlineOffset: style.outlineOffset,
      rgb, rgba, indicatorColor, indicatorRgb: indicatorRgba.slice(0, 3), indicatorRgba,
      borderColor: style.borderTopColor, borderWidth: style.borderTopWidth, boxShadow: style.boxShadow,
      fieldRingColor: fieldRing?.[1] ?? null, fieldRingSpread: fieldRing ? parseFloat(fieldRing[2]) : null,
      visible: (element as HTMLElement).checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      opacity: style.opacity, visibility: style.visibility,
      indicator: root.getPropertyValue("--accent-indicator").trim(),
      focusVisible: document.activeElement?.matches(":focus-visible"), bounds: element.getBoundingClientRect().toJSON() };
  });
}

async function inspectFocus(page: Page, owner: Locator, kind: "global" | "input" | "lattice" | "composite", name: string, info: TestInfo) {
  const initial = await outline(owner);
  const screenshot = info.outputPath(`${name}.png`);
  // R9 spec §3.2: a field's single ring is its 1px indicator border plus a 1px
  // --field-focus shadow, so its adjacent surface lies just outside that shadow.
  const captured = await sampleAdjacentFocus(page, screenshot, initial, () => outline(owner), value => (kind === "input"
    ? { bounds: value.bounds, offset: "0px", width: (value.fieldRingSpread ?? 0) + "px", foreground: value.indicatorRgb }
    : { bounds: value.bounds, offset: value.outlineOffset, width: value.outlineWidth, foreground: value.rgb }),
  value => [value.focusVisible, value.indicatorColor]);
  const { before: sample, after, edges, ...details } = captured;
  // Read pixels outside the visible ring, away from its antialiasing and the
  // control's own content. These are the actual adjacent compositor surfaces.
  expect.soft(sample.visible, name).toBe(true);
  expect.soft(sample.bounds.width, name).toBeGreaterThan(0);
  expect.soft(sample.bounds.height, name).toBeGreaterThan(0);
  expect.soft(sample.focusVisible, name).toBe(true);
  expect.soft(sample.outlineStyle, name).toBe("solid");
  expect.soft(sample.outlineWidth, name).toBe("2px");
  if (kind === "input") {
    // The outline stays only as the transparent forced-colors fallback.
    expect.soft(sample.outlineOffset, `${name} fallback outline offset`).toBe("-2px");
    expect.soft(sample.rgba, `${name} fallback outline is transparent`).toEqual([0, 0, 0, 0]);
    expect.soft(sample.borderColor, `${name} focused input border`).toBe(sample.indicatorColor);
    expect.soft(sample.borderWidth, name).toBe("1px");
    expect.soft(sample.fieldRingColor, `${name} field ring resolves indicator`).toBe(sample.indicatorColor);
    expect.soft(sample.fieldRingSpread, `${name} field ring spread`).toBe(1);
  } else {
    expect.soft(sample.outlineColor, `${name} resolves indicator`).toBe(sample.indicatorColor);
    expect.soft(sample.rgb, name).toEqual(sample.indicatorRgb);
  }
  expect.soft(after.bounds, `${name} screenshot geometry`).toEqual(sample.bounds);
  for (const edge of edges) {
    expect.soft(edge.valid, name + "/" + edge.side + " complete adjacent edge").toBe(true);
    expect.soft(edge.ratio, name + "/" + edge.side + " median contrast").not.toBeNull();
    if (edge.ratio !== null) expect.soft(edge.ratio, name + "/" + edge.side).toBeGreaterThanOrEqual(3);
  }
  return { kind, name, ...sample, after, edges, ...details };
}

for (const mode of ["full", "lite", "reduced"] as const) {
  nativeTest(`R2-01 light keyboard outlines remain visible in ${mode}`, async ({ page }, info) => {
    nativeTest.setTimeout(120000);
    await page.setViewportSize({ width: 1280, height: 720 });
    if (mode === "reduced") await page.emulateMedia({ reducedMotion: "reduce" });
    await installLauncherFixture(page, { theme: "light", effects: mode === "lite" ? "lite" : "full", instanceCount: 2 });
    await installFocusHaloPaintProbe(page);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const homeTabs = await tabTo(page, page.locator(".vx-instance-picker__trigger"), { info, path: `home-${mode}` });
    const home = await inspectFocus(page, page.locator(".vx-launch-console__selector-wrap"), "composite", `focus-home-light-${mode}`, info);
    await page.locator('.vx-floating-nav [data-page="library"]').click();
    await expect(page.locator('[data-page-stage="library"]')).toHaveCSS("opacity", "1");
    const libraryTabs = await tabTo(page, page.locator(".vx-library-page .vx-search input"), { info, path: `library-${mode}` });
    const library = await inspectFocus(page, page.locator(".vx-library-page .vx-search"), "composite", `focus-library-light-${mode}`, info);
    const extraTabs = [], contracts = [];
    for (const [id, selected] of [["fixture-world", true], ["fixture-world-002", false]] as const) {
      const card = page.locator(`.vx-instance-card[data-instance-id="${id}"]`);
      // Establish real pointer ownership first; Tab must hand off to the
      // visible keyboard frame even while the shared cursor owns this card.
      await card.hover();
      const target = card.locator(".vx-instance-card__select");
      extraTabs.push({ target: id, visited: await tabTo(page, target, { info, path: `${id}-${mode}` }) });
      const frame = card.locator(":scope > .vx-lattice-frame");
      await expect(frame).toHaveAttribute("data-focused", "true");
      await expect(frame).toHaveAttribute("data-selected", String(selected));
      await expect(frame).toHaveCSS("visibility", "visible");
      await expect(frame).toHaveCSS("opacity", "1");
      contracts.push(await inspectFocus(page, frame, "lattice", `focus-lattice-${selected ? "selected" : "unselected"}-${mode}`, info));
    }
    await page.locator(".vx-library-commandbar__actions").getByRole("button", { name: "创建实例", exact: true }).click();
    const dialog = page.locator(".vx-create-dialog[open]");
    await expect(dialog).toHaveCSS("opacity", "1");
    const input = dialog.locator('input[id$="-create-instance-name"]');
    extraTabs.push({ target: "input", visited: await tabTo(page, input, { info, path: `input-${mode}` }) });
    contracts.push(await inspectFocus(page, input, "input", `focus-input-${mode}`, info));
    const close = dialog.locator("[data-dialog-close]");
    extraTabs.push({ target: "global", visited: await tabTo(page, close, { info, path: `global-${mode}` }) });
    contracts.push(await inspectFocus(page, close, "global", `focus-global-${mode}`, info));
    const surfaces = [[243, 241, 235], [250, 249, 245], [234, 231, 224]];
    const samples = [home, library].map(value => ({ ...value, contrasts: surfaces.map(surface => contrast(value.rgb, surface)) }));
    await writeFile(info.outputPath("keyboard-focus.json"), JSON.stringify({ mode, homeTabs, libraryTabs, extraTabs, contracts, surfaces, samples }, null, 2));
    for (const sample of samples) {
      expect(sample.focusVisible).toBe(true);
      expect(sample.outlineStyle).toBe("solid");
      expect(sample.outlineWidth).toBe("2px");
      expect(sample.rgb).not.toEqual([180, 241, 122]);
      expect(sample.indicator).not.toBe("");
      expect(sample.outlineColor).toBe(sample.indicatorColor);
      expect(sample.rgb).toEqual(sample.indicatorRgb);
      for (const ratio of sample.contrasts) expect(ratio).toBeGreaterThanOrEqual(3);
    }
  });
}

nativeTest("R3-3 ruled focus sampling: the previously failing Close station retains its exact geometry", async ({ page }, info) => {
  nativeTest.setTimeout(120000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await installLauncherFixture(page, { theme: "light", effects: "full", instanceCount: 2 });
  await installFocusHaloPaintProbe(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const close = page.locator(".vx-window-chrome__controls").getByRole("button", { name: "关闭", exact: true });
  const visited = await tabTo(page, close, { info, path: "close-site" });
  const station = visited.at(-1)!;
  expect(station.label).toBe("关闭");
  // R9 ui-language-spec §2.6/§3.10: window controls are --control-sm (32px)
  // IconButtons and the global ring is a 2px outline at --focus-ring-offset
  // (2px), so the sampled edges sit 5/4px out.
  expect(station.bounds).toMatchObject({ left: 1221, top: 25, right: 1253, bottom: 57 });
  expect(station.edges!.map(edge => edge.distance)).toEqual([5, 4, 5, 4]);
  expect(station.edges![0].points.map(point => point.x)).toEqual(Array(32).fill(1216));
  for (const edge of station.edges!) {
    expect(edge.replacedPoints.every(point => point.haloAlpha! > 0)).toBe(true);
    expect(edge.unaffectedPoints.every(point => point.haloAlpha === 0)).toBe(true);
    expect(edge.backgroundStable).toBe(true);
    if (edge.backgroundCheckApplies && edge.maxBackgroundDelta !== null)
      expect(edge.maxBackgroundDelta).toBeLessThanOrEqual(8);
  }
  await writeFile(info.outputPath("failed-close-site.json"), JSON.stringify({
    ruling: "normal alpha>0 uses immediate halo-hidden reference; drift>8 retries once; original geometry and 3:1 retained", visited,
  }, null, 2));
});

nativeTest("R2-01 en light 1050 downloads completed columns have three-to-one contrast", async ({ page }, info) => {
  await page.setViewportSize({ width: 1050, height: 720 });
  await installLauncherFixture(page, { theme: "light", stress: true });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await page.locator('.vx-floating-nav [data-page="downloads"]').click();
  await expect(page.locator('[data-page-stage="downloads"]')).toHaveCSS("opacity", "1");
  // The first half of the active task is genuinely complete. Inspect its solid
  // columns; terminal history rows may later have no progress visualization.
  const canvas = page.locator('[data-task-id="task-long"] canvas.vx-lattice-progress');
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute("data-percent", "50");
  const readCores = () => canvas.evaluate(element => {
    const canvas = element as HTMLCanvasElement, context = canvas.getContext("2d")!;
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const token = getComputedStyle(document.documentElement);
    const color = token.getPropertyValue("--accent-indicator").trim() || token.getPropertyValue("--accent").trim();
    const probe = document.createElement("canvas"); probe.width = probe.height = 1;
    const p = probe.getContext("2d")!; p.fillStyle = color; p.fillRect(0, 0, 1, 1);
    const expected = [...p.getImageData(0, 0, 1, 1).data].slice(0, 3);
    const cores = [];
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width * .4; x++) {
      const offset = (y * canvas.width + x) * 4;
      if (bytes[offset + 3] === 255 && expected.every((value, index) => value === bytes[offset + index])) cores.push({ x, y });
    }
    return { cores, expected, bounds: canvas.getBoundingClientRect().toJSON(), width: canvas.width, height: canvas.height };
  });
  await expect.poll(async () => (await readCores()).cores.length).toBeGreaterThan(20);
  const painted = await readCores();
  const normal = decodePng(await page.screenshot({ path: info.outputPath("en-light-1050-downloads.png"), scale: "css" }));
  const previous = await canvas.evaluate(element => {
    const value = element.style.getPropertyValue("visibility"), priority = element.style.getPropertyPriority("visibility");
    element.style.setProperty("visibility", "hidden", "important"); return { value, priority };
  });
  let background;
  try {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    background = decodePng(await page.screenshot({ path: info.outputPath("downloads-under-progress.png"), scale: "css" }));
  } finally {
    await canvas.evaluate((element, previous) => {
      if (previous.value) element.style.setProperty("visibility", previous.value, previous.priority);
      else element.style.removeProperty("visibility");
    }, previous);
  }
  const samples = painted.cores.flatMap(core => {
    const x = Math.floor(painted.bounds.x + (core.x + .5) * painted.bounds.width / painted.width);
    const y = Math.floor(painted.bounds.y + (core.y + .5) * painted.bounds.height / painted.height);
    if (x < 0 || y < 0 || x >= normal.width || y >= normal.height) return [];
    const offset = (y * normal.width + x) * 4;
    const foreground = [...normal.pixels.subarray(offset, offset + 3)];
    // Ignore antialiased edges: only opaque dot cores whose compositor color
    // matches the actual canvas solid palette are contrast samples.
    if (foreground.some((value, index) => Math.abs(value - painted.expected[index]) > 2)) return [];
    const under = [...background.pixels.subarray(offset, offset + 3)];
    return [{ x, y, foreground, background: under, ratio: contrast(foreground, under) }];
  });
  const minimum = Math.min(...samples.map(sample => sample.ratio));
  await writeFile(info.outputPath("completed-columns-contrast.json"), JSON.stringify({
    progressPercent: 50, inspectedFraction: .4, palette: painted.expected, sampledPixels: samples.length, minimum,
    worst: [...samples].sort((a, b) => a.ratio - b.ratio).slice(0, 10),
  }, null, 2));
  expect(samples.length).toBeGreaterThan(20);
  expect(minimum).toBeGreaterThanOrEqual(3);
});

nativeTest("R2-02 keyboard launch follows preparation running and idle with the cancel guard", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await installLauncherFixture(page, { theme: "light", launchDelay: 0 });
  await page.addInitScript(() => {
    type Api = { invoke(name: string, args?: Record<string, unknown>): Promise<unknown> };
    type KeyRecord = { at: number; action: string | null; disabled: string | null };
    const host = window as unknown as { __TAURI_INTERNALS__?: Api;
      __focusFixture?: { finish(): void; keys: KeyRecord[] }; __appearanceFixtures?: { calls: { name: string }[] } };
    let finish = () => {}; const pending = new Promise<void>(resolve => { finish = resolve; });
    const keys: KeyRecord[] = [], wrapped = new WeakSet<Api>();
    function attach(api: Api) {
      if (wrapped.has(api)) return; wrapped.add(api);
      const invoke = api.invoke;
      api.invoke = async (name, args) => {
        const result = await invoke(name, args);
        if (name === "launch_game") await pending;
        return result;
      };
    }
    let api = host.__TAURI_INTERNALS__;
    Object.defineProperty(host, "__TAURI_INTERNALS__", { configurable: true, enumerable: true,
      get: () => api, set(value: Api) { api = value; attach(value); } });
    if (api) attach(api);
    host.__focusFixture = { finish, keys };
    document.addEventListener("keydown", event => {
      if (event.key === "Enter") keys.push({ at: performance.now(),
        action: (event.target as HTMLElement).getAttribute("data-launch-action"),
        disabled: (event.target as HTMLElement).getAttribute("aria-disabled") });
    }, true);
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-world-intro", "off");
  await tabTo(page, page.locator('[data-launch-action="idle"]'));
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  const guard = await page.evaluate(() => {
    const host = window as unknown as { __focusFixture: { keys: { at: number; action: string | null; disabled: string | null }[] };
      __appearanceFixtures: { calls: { name: string }[] } };
    return { keys: host.__focusFixture.keys, cancelled: host.__appearanceFixtures.calls.filter(call => call.name === "cancel_download_task").length };
  });
  await writeFile(info.outputPath("cancel-guard.json"), JSON.stringify(guard, null, 2));
  expect(guard.keys.map(key => key.action)).toEqual(["idle", "preparing"]);
  expect(guard.keys[1].at - guard.keys[0].at).toBeLessThan(250);
  expect(guard.keys[1].disabled).toBe("true");
  expect(guard.cancelled).toBe(0);
  await expect(page.locator('[data-launch-action="preparing"]')).toBeFocused();
  await page.screenshot({ path: info.outputPath("keyboard-preparing-light.png"), scale: "css" });
  await page.evaluate(() => (window as unknown as { __focusFixture: { finish(): void } }).__focusFixture.finish());
  await expect(page.locator('[data-launch-action="running"]')).toBeFocused();
  await page.screenshot({ path: info.outputPath("keyboard-running-light.png"), scale: "css" });
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-launch-action="idle"]')).toBeFocused();
  await page.screenshot({ path: info.outputPath("keyboard-ended-light.png"), scale: "css" });
});
