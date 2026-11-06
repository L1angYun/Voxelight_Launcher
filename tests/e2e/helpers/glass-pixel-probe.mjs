// SPDX-License-Identifier: GPL-3.0-only
// Diagnostic helper only. Call with a fixture-ready Playwright page; it starts
// no server/browser and adds no dependency. Every image is a real screenshot.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

export function decodePng(input) {
  const bytes = Buffer.from(input);
  let width = 0, height = 0, channels = 0;
  const compressed = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const kind = bytes.toString("ascii", at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (data[8] !== 8 || !channels || data[12] !== 0) throw new Error("Expected a non-interlaced RGB/RGBA PNG");
    }
    if (kind === "IDAT") compressed.push(data);
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const corner = x >= channels ? previous[x - channels] : 0;
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter];
      if (predictor === undefined) throw new Error(`Unexpected PNG filter ${filter}`);
      row[x] = (raw[cursor++] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      row.copy(pixels, out, x * channels, x * channels + 3);
      pixels[out + 3] = channels === 4 ? row[x * channels + 3] : 255;
    }
    previous = row;
  }
  return { width, height, pixels };
}

function pngChunk(kind, data) {
  const text = Buffer.from(kind);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([text, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  text.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

export function encodePng({ width, height, pixels }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(pixels).copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

function transitions(image, row) {
  const result = [];
  const level = (x) => image.pixels[(row * image.width + x) * 4];
  for (let x = 1; x < image.width; x++) {
    const a = level(x - 1), b = level(x);
    if ((a < 128 && b >= 128) || (a >= 128 && b < 128)) {
      result.push({ x: x - 1 + (128 - a) / (b - a), direction: Math.sign(b - a) });
    }
  }
  return result;
}

function matchOffsets(reference, actual, pairingRadius = 12) {
  return reference.map((edge) => {
    const match = actual.filter((other) => other.direction === edge.direction && Math.abs(other.x - edge.x) < pairingRadius)
      .sort((a, b) => Math.abs(a.x - edge.x) - Math.abs(b.x - edge.x))[0];
    return match ? { x: edge.x, offset: match.x - edge.x } : null;
  }).filter(Boolean);
}

/** Intersect the rounded SDF's flat core (distance <= -profileWidth) with a PNG row. */
export function flatGlassScanline(geometry, clip, row) {
  const { left, top, width, height, radius, inset, profileWidth } = geometry;
  const localY = clip.y + row + .5 - top;
  const inner = inset + profileWidth;
  if (localY < inner || localY > height - inner || width <= 2 * inner) return null;
  const flatRadius = Math.max(0, radius - profileWidth);
  const cornerY = Math.max(0, Math.abs(localY - height / 2) - (height / 2 - inner - flatRadius));
  const roundInset = flatRadius - Math.sqrt(Math.max(0, flatRadius ** 2 - cornerY ** 2));
  const localLeft = inner + roundInset, localRight = width - localLeft;
  // Transition coordinates interpolate between integer pixel-center indices.
  const offset = left - clip.x - .5;
  return { row, localY, localLeft, localRight, pngLeft: localLeft + offset, pngRight: localRight + offset };
}

export function measureGlassLiveShift(offsets, flatRegion) {
  const liveOffsets = [], bevelOffsets = [];
  const inFlatRegion = x => flatRegion !== null && x >= flatRegion.pngLeft && x <= flatRegion.pngRight;
  for (const edge of offsets) {
    (inFlatRegion(edge.x) && inFlatRegion(edge.x + edge.offset) ? liveOffsets : bevelOffsets).push(edge);
  }
  const liveShift = liveOffsets.length ? liveOffsets.reduce((sum, edge) => sum + edge.offset, 0) / liveOffsets.length : null;
  return { liveOffsets, bevelOffsets, liveShift,
    liveShiftPass: liveOffsets.length > 0 && liveOffsets.every(({ offset }) => offset >= 6 && offset <= 8) };
}

export async function probeGlassRefraction(page, outputDirectory, selector = ".vx-floating-nav__indicator") {
  await mkdir(outputDirectory, { recursive: true });
  const target = page.locator(selector).first();
  await target.waitFor({ state: "visible" });
  const initial = await target.evaluate(async (element) => {
    const { lensBoundaryPath, lensChromaticScales } = await import("/src/visual/glass/geometry.ts");
    // The pattern is behind the entire chrome, outside every slider ancestor.
    // Inserting it inside indicator-slot would bypass a broken Backdrop Root.
    const parent = document.querySelector(".vx-app-body");
    if (!parent) throw new Error("Missing real global backdrop host");
    const box = element.getBoundingClientRect(), parentBox = parent.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const image = element.querySelector("feImage[data-vx-curvature]");
    const contour = element.querySelector("[data-vx-contour]");
    if (!image || !contour) throw new Error("The stripe probe requires the live displacement image and contour");
    const width = Number(image.getAttribute("width")), height = Number(image.getAttribute("height"));
    const radius = Number.parseFloat(computed.borderTopLeftRadius);
    const bevel = Number.parseFloat(computed.getPropertyValue("--vx-lens-edge-width"));
    const refraction = Number.parseFloat(computed.getPropertyValue("--vx-lens-refraction"));
    const dispersion = Number.parseFloat(computed.getPropertyValue("--vx-lens-dispersion"));
    const inset = contour.getBBox().x;
    const scales = [...element.querySelectorAll("feDisplacementMap")];
    const restingScales = lensChromaticScales(0, 0, refraction, dispersion);
    const restingShape = { width, height, radius, inset, bevel, refraction, dispersion };
    let translationOnly = true;
    for (let node = element; node; node = node.parentElement) {
      const transform = getComputedStyle(node).transform;
      if (transform === "none") continue;
      const m = new DOMMatrixReadOnly(transform);
      translationOnly &&= [m.m11 - 1, m.m22 - 1, m.m33 - 1, m.m44 - 1, m.m12, m.m13, m.m14,
        m.m21, m.m23, m.m24, m.m31, m.m32, m.m34].every(value => Math.abs(value) < 1e-6);
    }
    // feImage uses userSpaceOnUse and the rounded layout dimensions. An
    // English label can give the DOM a fractional width without scaling that
    // geometry. Use the actual DOM bounds for capture and CSS pixels for SDF.
    if (!translationOnly || element.offsetWidth !== width || element.offsetHeight !== height
      || !Object.values(restingShape).every(Number.isFinite) || width <= 0 || height <= 0 || bevel <= 0 || inset < 0
      || contour.getAttribute("d") !== lensBoundaryPath(restingShape)
      || scales.length !== restingScales.length || scales.some((node, index) =>
        Math.abs(Number(node.getAttribute("scale")) - restingScales[index]) > .000501)) {
      throw new Error(`The stripe probe requires settled geometry: ${JSON.stringify({ box: box.toJSON(), restingShape, translationOnly })}`);
    }
    const left = box.left + window.scrollX, top = box.top + window.scrollY;
    const effectiveRadius = Math.min(radius, width / 2 - inset, height / 2 - inset);
    const effectiveBevel = Math.min(bevel, .44 * (width - 2 * inset), .44 * (height - 2 * inset));
    const preserved = .48 * Math.max(...restingScales, ...restingScales.map(scale => Number(scale.toFixed(3)))) <= .5 * effectiveBevel;
    const geometry = { left, top, width, height, inset, radius: effectiveRadius, effectiveBevel,
      profileWidth: preserved ? effectiveBevel : Math.min(effectiveBevel, effectiveRadius) };
    const x = Math.floor(left), y = Math.floor(top);
    const crop = { x, y, width: Math.ceil(box.right + window.scrollX) - x, height: Math.ceil(box.bottom + window.scrollY) - y };
    const snapshot = () => {
      const b = element.getBoundingClientRect();
      return JSON.stringify([b.left + window.scrollX, b.top + window.scrollY, b.width, b.height,
        element.dataset.lensOpticsEpoch, image.getAttribute("href"), element.style.clipPath,
        scales.map(node => node.getAttribute("scale"))]);
    };
    const layer = document.createElement("div");
    layer.dataset.vxProbeStripes = "true";
    Object.assign(layer.style, {
      position: "absolute", pointerEvents: "none", zIndex: "0",
      left: `${box.left - parentBox.left - parent.clientLeft + parent.scrollLeft}px`,
      top: `${box.top - parentBox.top - parent.clientTop + parent.scrollTop}px`,
      width: `${box.width}px`, height: `${box.height}px`,
      background: "repeating-linear-gradient(90deg, #000 0px, #000 16px, #fff 16px, #fff 32px)",
    });
    const style = document.createElement("style");
    style.textContent = `.vx-glass-canvas { visibility:hidden!important; }
      .vx-floating-nav__group { visibility:hidden!important; }
      [data-vx-probe-glass]::before,[data-vx-probe-glass]::after { display:none!important; }
      [data-vx-probe-glass] > :not(.vx-liquid-filter-defs) { visibility:hidden!important; }`;
    window.__vxGlassPixelProbe = {
      element, parent, layer, style, elementStyle: element.style.cssText,
      parentStyle: parent.style.cssText, filter: computed.backdropFilter,
      snapshot, initialSnapshot: snapshot(),
    };
    document.head.append(style);
    if (getComputedStyle(parent).position === "static") parent.style.position = "relative";
    parent.append(layer);
    element.dataset.vxProbeGlass = "true";
    Object.assign(element.style, { position: "relative", zIndex: "1", boxShadow: "none", borderColor: "transparent" });
    const ancestorBackdropFilters = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const filter = getComputedStyle(ancestor).backdropFilter;
      if (filter && filter !== "none") ancestorBackdropFilters.push({ className: ancestor.className, filter });
    }
    return { width: box.width, height: box.height, radius: Number.parseFloat(computed.borderTopLeftRadius),
      filter: computed.backdropFilter, backgroundColor: computed.backgroundColor, backgroundImage: computed.backgroundImage,
      sourceParentClass: parent.className, ancestorBackdropFilters, geometry, crop };
  });
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const capture = async (name) => {
    await settle();
    const stable = () => page.evaluate(() => {
      const s = window.__vxGlassPixelProbe;
      return s.snapshot() === s.initialSnapshot;
    });
    if (!await stable()) throw new Error(`Lens geometry or map changed before ${name}`);
    const image = decodePng(await page.screenshot({ clip: initial.crop, path: join(outputDirectory, `${name}.png`), scale: "css" }));
    if (image.width !== initial.crop.width || image.height !== initial.crop.height || !await stable())
      throw new Error(`Lens geometry, map, or PNG coordinate grid changed during ${name}`);
    return image;
  };
  try {
    const full = await capture("stripes-full");
    await page.evaluate(() => { window.__vxGlassPixelProbe.layer.style.backgroundPositionX = "7px"; });
    const moved = await capture("stripes-live-shift-7px");
    await page.evaluate(() => {
      const s = window.__vxGlassPixelProbe;
      s.layer.style.backgroundPositionX = "0px";
      s.element.style.setProperty("backdrop-filter", "none", "important");
      s.element.style.setProperty("-webkit-backdrop-filter", "none", "important");
    });
    const plain = await capture("stripes-unfiltered");
    await page.evaluate(() => {
      const s = window.__vxGlassPixelProbe;
      s.layer.style.background = "#808080";
      s.element.style.setProperty("backdrop-filter", s.filter, "important");
      s.element.style.setProperty("-webkit-backdrop-filter", s.filter, "important");
    });
    const uniformFull = await capture("uniform-full");
    await page.evaluate(() => {
      const s = window.__vxGlassPixelProbe;
      s.element.style.setProperty("backdrop-filter", "none", "important");
      s.element.style.setProperty("-webkit-backdrop-filter", "none", "important");
    });
    const uniformPlain = await capture("uniform-unfiltered");
    const middle = Math.floor(full.height / 2);
    const safeMargin = Math.min(32, full.width * .25);
    const centerOffsets = matchOffsets(transitions(plain, middle), transitions(full, middle))
      .filter((edge) => edge.x > safeMargin && edge.x < full.width - safeMargin);
    const rows = [];
    for (let y = 3; y <= Math.min(22, middle - 1); y++) {
      rows.push({ y, edges: matchOffsets(transitions(plain, y), transitions(full, y))
        .filter((edge) => edge.x < 32 || edge.x > full.width - 32) });
    }
    const liveFlatRegion = flatGlassScanline(initial.geometry, initial.crop, middle);
    const beforeEdges = transitions(full, middle);
    // Same-polarity stripe boundaries repeat every 32px. Half that period
    // identifies a correspondence without using the 6–8px acceptance band.
    const paired = matchOffsets(beforeEdges, transitions(moved, middle), 16);
    const unmatchedLiveEdges = beforeEdges.filter(edge => !paired.some(pair => pair.x === edge.x));
    const live = measureGlassLiveShift(paired, liveFlatRegion);
    const maxEdgeShift = Math.max(0, ...rows.flatMap((row) => row.edges.map((edge) => Math.abs(edge.offset))));
    const maxCenterShift = Math.max(0, ...centerOffsets.map((edge) => Math.abs(edge.offset)));
    let maxUniformDelta = 0;
    for (let y = Math.floor(full.height * 0.4); y < full.height * 0.6; y++) {
      for (let x = Math.floor(full.width * 0.3); x < full.width * 0.7; x++) {
        const at = (y * full.width + x) * 4;
        for (let c = 0; c < 3; c++) maxUniformDelta = Math.max(maxUniformDelta,
          Math.abs(uniformFull.pixels[at + c] - uniformPlain.pixels[at + c]));
      }
    }
    const diff = Buffer.alloc(full.pixels.length);
    for (let at = 0; at < diff.length; at += 4) {
      for (let c = 0; c < 3; c++) diff[at + c] = Math.min(255, Math.abs(full.pixels[at + c] - plain.pixels[at + c]) * 4);
      diff[at + 3] = 255;
    }
    await writeFile(join(outputDirectory, "stripes-difference-4x.png"), encodePng({ ...full, pixels: diff }));
    const report = { initial, maxEdgeShift, maxCenterShift, maxUniformDelta, rows, centerOffsets, liveFlatRegion, unmatchedLiveEdges, ...live,
      pass: maxEdgeShift >= 2 && maxCenterShift <= 1 && live.liveShiftPass && maxUniformDelta <= 1 };
    await writeFile(join(outputDirectory, "glass-pixel-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await page.evaluate(() => {
      const s = window.__vxGlassPixelProbe;
      s.element.style.cssText = s.elementStyle;
      s.parent.style.cssText = s.parentStyle;
      delete s.element.dataset.vxProbeGlass;
      s.layer.remove(); s.style.remove();
      delete window.__vxGlassPixelProbe;
    });
  }
}
