// SPDX-License-Identifier: GPL-3.0-only
import { expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { decodePng } from "./glass-pixel-probe.mjs";

/** Fixed geometry candidates; never choose pixels based on their brightness. */
export async function captureReadingSurface(page: Page, selector: string, screenshot: string) {
  // Detail content fades on an ancestor while the panel's own opacity is 1.
  // Sample the completed presentation, retaining the later geometry check.
  await expect.poll(() => page.locator(selector).first().evaluate(element => {
    for (let owner: Element | null = element; owner; owner = owner.parentElement)
      if (Number(getComputedStyle(owner).opacity) !== 1) return false;
    return true;
  }), { message: `${selector}: ancestor fades completed` }).toBe(true);
  const metadata = await page.locator(selector).first().evaluate(target => {
    const describe = (element: Element) => `${element.tagName.toLowerCase()}.${[...element.classList].join(".")}`;
    const shown = (element: Element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      && !element.closest('.sr-only,[hidden],dialog:not([open])');
    const bounds = (element: Element) => element.getBoundingClientRect().toJSON() as DOMRect;
    type Obstacle = { x: number; y: number; width: number; height: number; right: number; bottom: number; owner: string };
    const obstacles = (root: Element) => {
      const result: Obstacle[] = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode, parent = node.parentElement;
        if (!node.textContent?.trim() || !parent || !shown(parent)) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        for (const rect of range.getClientRects()) if (rect.width && rect.height) result.push({ ...rect.toJSON(), owner: describe(parent) });
      }
      for (const element of root.querySelectorAll("canvas,img,svg,button,input,select,textarea,video,.vx-glass-surface")) {
        if (!shown(element) || element.matches(".world-scene__canvas,.vx-cursor-halo,.vx-glass-canvas")) continue;
        result.push({ ...bounds(element), owner: describe(element) });
      }
      return result;
    };
    const rect = bounds(target), css = getComputedStyle(target), size = 6;
    const radius = Math.max(12, ...[css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomLeftRadius, css.borderBottomRightRadius].map(value => parseFloat(value) || 0));
    const patch = (name: string, x: number, y: number) => ({ name, x: Math.ceil(x), y: Math.ceil(y), width: size, height: size });
    const corners = [patch("top-left", rect.left + radius + 8, rect.top + 8), patch("top-right", rect.right - radius - 14, rect.top + 8),
      patch("bottom-left", rect.left + radius + 8, rect.bottom - 14), patch("bottom-right", rect.right - radius - 14, rect.bottom - 14)];
    const gutters = [patch("left-gutter", 24, innerHeight * .62), patch("right-gutter", innerWidth - 30, innerHeight * .62)];
    const validate = (candidate: ReturnType<typeof patch>, blocks: Obstacle[], onSurface: boolean) => {
      const rejects: string[] = [];
      if (candidate.x < 0 || candidate.y < 100 || candidate.x + size > innerWidth || candidate.y + size > innerHeight) rejects.push("Outside content viewport");
      if (onSurface && (candidate.x < rect.left + 2 || candidate.x + size > rect.right - 2 || candidate.y < rect.top + 2 || candidate.y + size > rect.bottom - 2)) rejects.push("Outside the surface interior");
      const overlaps = blocks.filter(block => candidate.x < block.right && candidate.x + size > block.x && candidate.y < block.bottom && candidate.y + size > block.y);
      if (overlaps.length) rejects.push("Overlaps text, control or media");
      const hits = [[.5, .5], [5.5, .5], [.5, 5.5], [5.5, 5.5], [3, 3]].map(([x, y]) => {
        const hit = document.elementFromPoint(candidate.x + x, candidate.y + y);
        if (onSurface && hit !== target && !target.contains(hit)) rejects.push("Covered by another DOM branch");
        return hit ? describe(hit) : null;
      });
      return { ...candidate, valid: !rejects.length, rejects: [...new Set(rejects)], overlaps, hits };
    };
    const surfaceCandidates = corners.map(patch => validate(patch, obstacles(target), true));
    const pageCandidates = gutters.map(patch => validate(patch, obstacles(document.body), false));
    return { target: { classes: target.className, bounds: rect, shown: shown(target), background: css.backgroundColor },
      surfaceCandidates, pageCandidates, surface: surfaceCandidates.find(patch => patch.valid) ?? null,
      page: pageCandidates.find(patch => patch.valid) ?? null };
  });
  const image = decodePng(await page.screenshot({ path: screenshot, scale: "css" }));
  const after = await page.locator(selector).first().boundingBox();
  await writeFile(screenshot.replace(/\.png$/, ".geometry.json"), JSON.stringify({ selector, metadata, after }, null, 2));
  expect(metadata.target.shown, `${selector}: visible surface`).toBeTruthy();
  expect(metadata.surface, `${selector}: unobstructed fixed surface patch`).not.toBeNull();
  expect(metadata.page, `${selector}: unobstructed fixed page patch`).not.toBeNull();
  expect(after, `${selector}: geometry after screenshot`).not.toBeNull();
  for (const key of ["x", "y", "width", "height"] as const)
    expect(Math.abs(after![key] - metadata.target.bounds[key]), `${selector}: stable ${key}`).toBeLessThan(.01);
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return (sorted[17] + sorted[18]) / 2; };
  const measure = (patch: NonNullable<typeof metadata.surface>) => {
    const pixels: number[][] = [];
    for (let y = patch.y; y < patch.y + patch.height; y++) for (let x = patch.x; x < patch.x + patch.width; x++) {
      const offset = (y * image.width + x) * 4;
      pixels.push([...image.pixels.subarray(offset, offset + 3)]);
    }
    expect(pixels).toHaveLength(36);
    const brightness = pixels.map(rgb => (rgb[0] + rgb[1] + rgb[2]) / 3);
    return { patch, pixels, medianRGB: [0, 1, 2].map(channel => median(pixels.map(rgb => rgb[channel]))),
      medianBrightness: median(brightness), minimum: Math.min(...brightness), maximum: Math.max(...brightness) };
  };
  return { selector, screenshot, metadata, surface: measure(metadata.surface!), page: measure(metadata.page!) };
}

/** Explicit reading surfaces, not controls, icons or status badges. */
export async function readLargeReadingFills(page: Page) {
  return page.evaluate(() => {
    const tokens = ["--world-ink", "--bg-base", "--surface-panel", "--surface-card", "--selection-fill"];
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const rgba = (color: string) => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data]; };
    const probe = document.createElement("span"); probe.style.display = "none"; document.body.append(probe);
    const allowed = tokens.map(token => { probe.style.color = `var(${token})`; return { token, rgba: rgba(getComputedStyle(probe).color) }; });
    probe.remove();
    const selectors = [".vx-panel", ".vx-card", ".vx-instance-card", ".vx-appearance-preview", ".vx-detail-workspace", ".vx-detail-section",
      ".vx-library-commandbar", ".vx-server-inventory", ".vx-server-row", ".vx-managed-overview", ".vx-managed-console", ".vx-task-row"];
    const rows = [...document.querySelectorAll<HTMLElement>(selectors.join(","))].filter(element => {
      const bounds = element.getBoundingClientRect();
      return !element.closest('[inert],[aria-hidden="true"],dialog') && element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
        && bounds.width >= 200 && bounds.height >= 64 && bounds.bottom > 100 && bounds.top < innerHeight;
    }).map(element => {
      const css = getComputedStyle(element), color = rgba(css.backgroundColor);
      return { classes: element.className, bounds: element.getBoundingClientRect().toJSON(), background: css.backgroundColor,
        rgba: color, allowedTokens: allowed.filter(row => row.rgba.every((value, index) => value === color[index])).map(row => row.token) };
    });
    return { selectors, allowed, rows: rows.filter(row => row.rgba[3] > 0), transparentContainers: rows.filter(row => row.rgba[3] === 0) };
  });
}
