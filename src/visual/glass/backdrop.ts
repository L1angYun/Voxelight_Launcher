// SPDX-License-Identifier: GPL-3.0-only
// A procedural, voxel-stepped landscape that glass surfaces refract. It is painted again only when the theme or accent changes,
// onto a small offscreen canvas. Nothing here reads the page, a screenshot or an image file.
import { clamp } from "./jelly";

export type Rgb = [number, number, number];

const fallbackAccent = "#b4f17a";
const ridgeLayers = 4;
const ridgeSteps = 22;

export function parseHex(value: string, fallback = fallbackAccent): Rgb {
  const text = value.trim();
  const hex = /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)) as Rgb;
}

export function mixHex(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const k = clamp(amount, 0, 1);
  const channels = a.map((channel, index) => Math.round(channel + (b[index] - channel) * k));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1).toFixed(3)})`;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const octaves = [
  { every: 9, weight: 0.6 },
  { every: 4, weight: 0.3 },
  { every: 2, weight: 0.1 },
];

/** Column heights in whole voxel steps; neighbouring columns differ by at most two steps, so the skyline reads as stacked blocks. */
export function ridgeProfile(seed: number, columns: number, steps: number = ridgeSteps): number[] {
  const random = seededRandom(seed);
  const lattices = octaves.map((octave) => Array.from({ length: Math.ceil(columns / octave.every) + 2 }, () => random()));
  const heights = Array.from({ length: columns }, (_, column) => {
    const level = octaves.reduce((sum, octave, index) => {
      const at = column / octave.every;
      const left = Math.floor(at);
      const fraction = at - left;
      const eased = fraction * fraction * (3 - 2 * fraction);
      const from = lattices[index][left];
      const to = lattices[index][left + 1];
      return sum + (from + (to - from) * eased) * octave.weight;
    }, 0);
    return Math.round(level * steps);
  });
  for (let column = 1; column < columns; column += 1) {
    heights[column] = clamp(heights[column], heights[column - 1] - 2, heights[column - 1] + 2);
  }
  return heights.map((height) => clamp(height, 0, steps));
}

export interface BackdropPalette {
  skyTop: string;
  skyMid: string;
  skyHorizon: string;
  sun: string;
  ridges: string[];
}

const night = { top: "#020509", mid: "#08111c", horizon: "#1a2e42", sun: "#f2ddb5", far: "#192438", near: "#040810" };
const day = { top: "#c8d8e8", mid: "#e8e4da", horizon: "#f0d8b8", sun: "#fff8e8", far: "#a8bcc8", near: "#5a6e7a" };

export function backdropPalette(light: boolean, accent: string): BackdropPalette {
  const base = light ? day : night;
  return {
    skyTop: base.top,
    skyMid: base.mid,
    skyHorizon: mixHex(base.horizon, accent, light ? 0.18 : 0.30),
    sun: base.sun,
    ridges: Array.from({ length: ridgeLayers }, (_, index) =>
      mixHex(mixHex(base.far, base.near, index / (ridgeLayers - 1)), accent, 0.10 - index * 0.025),
    ),
  };
}

// Any CSS colour the page uses for its accent is reduced to a plain hex value by letting the canvas parse it.
function resolveAccent(context: CanvasRenderingContext2D, value: string): string {
  const sentinel = "#010203";
  context.fillStyle = sentinel;
  context.fillStyle = value;
  if (context.fillStyle === sentinel) return fallbackAccent;
  context.clearRect(0, 0, 1, 1);
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function paintVoxelBackdrop({
  light,
  accent,
  width = 640,
  height = 360,
}: {
  light: boolean;
  accent: string;
  width?: number;
  height?: number;
}): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const tone = resolveAccent(context, accent);
    const palette = backdropPalette(light, tone);

    const sky = context.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, palette.skyTop);
    sky.addColorStop(0.5, palette.skyMid);
    sky.addColorStop(1, palette.skyHorizon);
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);

    const sunX = width * 0.74;
    const sunY = height * 0.24;
    const sunSize = height * 0.11;
    // Broad atmospheric glow
    const glow = context.createRadialGradient(sunX, sunY, 0, sunX, sunY, height * 0.72);
    glow.addColorStop(0, withAlpha(palette.sun, light ? 0.48 : 0.58));
    glow.addColorStop(0.3, withAlpha(palette.sun, light ? 0.18 : 0.28));
    glow.addColorStop(1, withAlpha(palette.sun, 0));
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);
    // Inner tight glow
    const innerGlow = context.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunSize * 2.8);
    innerGlow.addColorStop(0, withAlpha(palette.sun, light ? 0.62 : 0.78));
    innerGlow.addColorStop(1, withAlpha(palette.sun, 0));
    context.fillStyle = innerGlow;
    context.fillRect(0, 0, width, height);
    // Sun pixel block
    context.fillStyle = palette.sun;
    context.fillRect(Math.round(sunX - sunSize / 2), Math.round(sunY - sunSize / 2), Math.round(sunSize), Math.round(sunSize));

    const shaft = context.createLinearGradient(sunX, sunY, sunX - width * 0.4, height);
    shaft.addColorStop(0, withAlpha(palette.sun, light ? 0.26 : 0.20));
    shaft.addColorStop(1, withAlpha(palette.sun, 0));
    context.fillStyle = shaft;
    context.beginPath();
    context.moveTo(sunX - sunSize / 2, sunY + sunSize / 2);
    context.lineTo(sunX + sunSize / 2, sunY + sunSize / 2);
    context.lineTo(sunX - width * 0.2, height);
    context.lineTo(sunX - width * 0.55, height);
    context.closePath();
    context.fill();

    palette.ridges.forEach((color, layer) => {
      const columns = 34 + layer * 8;
      const profile = ridgeProfile(7919 * (layer + 1), columns);
      const baseline = height * (0.5 + layer * 0.1);
      const reach = height * (0.19 - layer * 0.025);
      const stepHeight = reach / ridgeSteps;
      const columnWidth = width / columns;
      const lip = Math.max(1, height * 0.004);
      profile.forEach((level, column) => {
        const left = Math.floor(column * columnWidth);
        const top = baseline - level * stepHeight;
        context.fillStyle = color;
        context.fillRect(left, top, Math.ceil(columnWidth) + 1, height - top);
      context.fillStyle = withAlpha(palette.sun, light ? 0.22 : 0.14);
        context.fillRect(left, top, Math.ceil(columnWidth) + 1, lip);
      });
      context.fillStyle = withAlpha(palette.skyHorizon, 0.3 - layer * 0.08);
      context.fillRect(0, baseline - reach, width, height - baseline + reach);
    });

    const ribbon = context.createLinearGradient(0, 0, width, 0);
    ribbon.addColorStop(0, withAlpha(tone, 0));
    ribbon.addColorStop(0.4, withAlpha(tone, light ? 0.18 : 0.28));
    ribbon.addColorStop(0.65, withAlpha(tone, light ? 0.14 : 0.22));
    ribbon.addColorStop(1, withAlpha(tone, 0));
    context.fillStyle = ribbon;
    context.fillRect(0, height * 0.55, width, height * 0.08);
    // Second thinner ribbon for depth
    const ribbon2 = context.createLinearGradient(0, 0, width, 0);
    ribbon2.addColorStop(0, withAlpha(tone, 0));
    ribbon2.addColorStop(0.5, withAlpha(tone, light ? 0.06 : 0.10));
    ribbon2.addColorStop(1, withAlpha(tone, 0));
    context.fillStyle = ribbon2;
    context.fillRect(0, height * 0.5, width, height * 0.04);

    // Dot-matrix grain: gives the glass refraction some texture to bend, even on flat sky areas
    const grain = seededRandom(31337);
    const dots = Math.round((width / 9) * (height / 9));
    context.fillStyle = light ? "rgba(0, 0, 0, 0.018)" : "rgba(255, 255, 255, 0.025)";
    context.beginPath();
    for (let index = 0; index < dots; index += 1) {
      const x = grain() * width;
      const y = grain() * height;
      context.moveTo(x + 0.7, y);
      context.arc(x, y, 0.7, 0, Math.PI * 2);
    }
    context.fill();

    if (!light) {
      // Deep corner vignette for cinematic depth
      const vignette = context.createRadialGradient(width / 2, height * 0.55, height * 0.25, width / 2, height * 0.55, width * 0.7);
      vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
      vignette.addColorStop(1, "rgba(0, 0, 0, 0.55)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, width, height);
    } else {
      // Subtle light-mode vignette to darken edges
      const vignette = context.createRadialGradient(width / 2, height * 0.5, height * 0.3, width / 2, height * 0.5, width * 0.65);
      vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
      vignette.addColorStop(1, "rgba(0, 0, 0, 0.12)");
      context.fillStyle = vignette;
      context.fillRect(0, 0, width, height);
    }
    return canvas;
  } catch {
    return null;
  }
}
