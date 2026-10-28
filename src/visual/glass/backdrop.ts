// SPDX-License-Identifier: GPL-3.0-only
// Static cube optics shared by the page background and glass refraction. The
// canvas is painted only when the resolved theme or accent changes.
import { clamp } from "./jelly";

export type Rgb = [number, number, number];

const fallbackAccent = "#b4f17a";
const ridgeLayers = 4;
const ridgeSteps = 22;
const backdropCubePitch = 9;
const backdropCubeSize = 3;
const backdropCubeTop = 1.3;
const backdropCubeSide = 1.3;
const darkBase = "#08101a";
const darkDeep = "#03070d";
const lightBase = "#f0f2f6";
const lightDeep = "#e6eaf0";
const white = "#ffffff";
const black = "#000000";
const twoPi = Math.PI * 2;

const backdropBeams = [
  {
    originX: 1.06,
    originY: -0.12,
    angle: Math.PI - 0.36,
    widthRatio: 0.01,
    strength: 1,
  },
  {
    originX: 0.88,
    originY: -0.2,
    angle: Math.PI - 0.28,
    widthRatio: 0.006,
    strength: 0.72,
  },
] as const;

export function parseHex(value: string, fallback = fallbackAccent): Rgb {
  const text = value.trim();
  const hex = /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
  return [1, 3, 5].map((start) =>
    Number.parseInt(hex.slice(start, start + 2), 16),
  ) as Rgb;
}

export function mixHex(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const weight = clamp(amount, 0, 1);
  const channels = a.map((channel, index) =>
    Math.round(channel + (b[index] - channel) * weight),
  );
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
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const octaves = [
  { every: 9, weight: 0.6 },
  { every: 4, weight: 0.3 },
  { every: 2, weight: 0.1 },
];

/** Deterministic profile retained as part of the backdrop helper API. */
export function ridgeProfile(
  seed: number,
  columns: number,
  steps: number = ridgeSteps,
): number[] {
  const random = seededRandom(seed);
  const lattices = octaves.map((octave) =>
    Array.from({ length: Math.ceil(columns / octave.every) + 2 }, () =>
      random(),
    ),
  );
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
    heights[column] = clamp(
      heights[column],
      heights[column - 1] - 2,
      heights[column - 1] + 2,
    );
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

const night = {
  top: "#020509",
  mid: "#08111c",
  horizon: "#1a2e42",
  sun: "#f2ddb5",
  far: "#192438",
  near: "#040810",
};
const day = {
  top: "#c8d8e8",
  mid: "#e8e4da",
  horizon: "#f0d8b8",
  sun: "#fff8e8",
  far: "#a8bcc8",
  near: "#5a6e7a",
};

export function backdropPalette(
  light: boolean,
  accent: string,
): BackdropPalette {
  const base = light ? day : night;
  return {
    skyTop: base.top,
    skyMid: base.mid,
    skyHorizon: mixHex(base.horizon, accent, light ? 0.18 : 0.3),
    sun: base.sun,
    ridges: Array.from({ length: ridgeLayers }, (_, index) =>
      mixHex(
        mixHex(base.far, base.near, index / (ridgeLayers - 1)),
        accent,
        0.1 - index * 0.025,
      ),
    ),
  };
}

function normalizeAccent(value: string): string {
  const [r, g, b] = parseHex(value);
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function drawCubeFace(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  front: string,
  top: string,
  side: string,
) {
  const half = backdropCubeSize / 2;
  const left = x - half;
  const right = x + half;
  const upper = y - half;
  const lower = y + half;

  context.fillStyle = side;
  context.beginPath();
  context.moveTo(right, upper);
  context.lineTo(right + backdropCubeSide, upper - backdropCubeTop);
  context.lineTo(right + backdropCubeSide, lower);
  context.lineTo(right, lower);
  context.closePath();
  context.fill();

  context.fillStyle = top;
  context.beginPath();
  context.moveTo(left, upper);
  context.lineTo(right, upper);
  context.lineTo(right + backdropCubeSide, upper - backdropCubeTop);
  context.lineTo(left + backdropCubeSide, upper - backdropCubeTop);
  context.closePath();
  context.fill();

  context.fillStyle = front;
  context.fillRect(left, upper, backdropCubeSize, backdropCubeSize);
}

function drawCubeLattice(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  light: boolean,
  accent: string,
) {
  const base = light ? lightBase : darkBase;
  const top = mixHex(base, white, light ? 0.12 : 0.25);
  const side = mixHex(base, black, light ? 0.1 : 0.2);
  const separator = withAlpha(mixHex(base, black, 0.3), light ? 0.16 : 0.28);
  const accentWhite = mixHex(accent, white, 0.1);

  context.save();
  for (
    let row = 0;
    row * backdropCubePitch < height + backdropCubePitch;
    row += 1
  ) {
    for (
      let column = 0;
      column * backdropCubePitch < width + backdropCubePitch;
      column += 1
    ) {
      const x = (column + 0.5) * backdropCubePitch;
      const y = (row + 0.5) * backdropCubePitch;
      const seed = Math.sin(column * 17.17 + row * 43.31) * 0.5 + 0.5;
      context.globalAlpha = (light ? 0.22 : 0.3) + seed * (light ? 0.12 : 0.2);
      drawCubeFace(
        context,
        x,
        y,
        mixHex(base, accentWhite, seed > 0.94 ? 0.22 : 0),
        top,
        side,
      );
      context.globalAlpha = 0.15 + seed * 0.13;
      context.fillStyle = separator;
      context.fillRect(x + 2.2, y - 1.5, 1, 4.2);
    }
  }
  context.globalAlpha = 1;
  context.restore();
}

function drawBeam(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  accent: string,
  light: boolean,
  beam: (typeof backdropBeams)[number],
) {
  const travel = Math.hypot(width, height) * 1.4;
  const beamWidth = Math.max(4, width * beam.widthRatio);
  context.save();
  context.translate(beam.originX * width, beam.originY * height);
  context.rotate(beam.angle);

  const crossFade = context.createLinearGradient(
    0,
    -beamWidth / 2,
    0,
    beamWidth / 2,
  );
  crossFade.addColorStop(0, withAlpha(accent, 0));
  crossFade.addColorStop(
    0.48,
    withAlpha(accent, (light ? 0.035 : 0.055) * beam.strength),
  );
  crossFade.addColorStop(
    0.52,
    withAlpha(accent, (light ? 0.04 : 0.064) * beam.strength),
  );
  crossFade.addColorStop(1, withAlpha(accent, 0));
  context.fillStyle = crossFade;
  context.globalAlpha = 1;
  context.fillRect(0, -beamWidth / 2, travel, beamWidth);

  const origin = context.createRadialGradient(0, 0, 0, 0, 0, beamWidth * 5);
  origin.addColorStop(0, withAlpha(accent, light ? 0.07 : 0.11));
  origin.addColorStop(1, withAlpha(accent, 0));
  context.fillStyle = origin;
  context.beginPath();
  context.arc(0, 0, beamWidth * 5, 0, twoPi);
  context.fill();
  context.restore();
}

function drawMotes(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  accent: string,
  light: boolean,
) {
  const random = seededRandom(0x76e1d7);
  const pale = mixHex(accent, white, 0.58);
  context.save();
  context.fillStyle = pale;
  for (let index = 0; index < 18; index += 1) {
    const x = random() * width;
    const y = random() * height;
    const radius = 0.45 + random() * 0.8;
    context.globalAlpha =
      (light ? 0.06 : 0.09) + random() * (light ? 0.08 : 0.13);
    context.beginPath();
    context.arc(x, y, radius, 0, twoPi);
    context.fill();
  }
  context.globalAlpha = 1;
  context.restore();
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
    const canvasWidth = Math.max(1, Math.round(width));
    const canvasHeight = Math.max(1, Math.round(height));
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;

    const accentTone = normalizeAccent(accent);
    const base = light ? lightBase : darkBase;
    const deep = light ? lightDeep : darkDeep;
    const background = context.createLinearGradient(
      0,
      0,
      canvasWidth * 0.86,
      canvasHeight,
    );
    background.addColorStop(0, base);
    background.addColorStop(0.56, deep);
    background.addColorStop(1, base);
    context.fillStyle = background;
    context.fillRect(0, 0, canvasWidth, canvasHeight);

    const sourceGlow = context.createRadialGradient(
      canvasWidth * 1.02,
      -canvasHeight * 0.1,
      0,
      canvasWidth * 1.02,
      -canvasHeight * 0.1,
      Math.max(canvasWidth, canvasHeight) * 0.78,
    );
    sourceGlow.addColorStop(0, withAlpha(accentTone, light ? 0.07 : 0.1));
    sourceGlow.addColorStop(0.34, withAlpha(accentTone, light ? 0.025 : 0.04));
    sourceGlow.addColorStop(1, withAlpha(accentTone, 0));
    context.fillStyle = sourceGlow;
    context.fillRect(0, 0, canvasWidth, canvasHeight);

    drawCubeLattice(context, canvasWidth, canvasHeight, light, accentTone);

    context.save();
    context.globalCompositeOperation = light ? "source-over" : "screen";
    for (const beam of backdropBeams) {
      drawBeam(context, canvasWidth, canvasHeight, accentTone, light, beam);
    }
    context.restore();
    drawMotes(context, canvasWidth, canvasHeight, accentTone, light);

    const vignette = context.createRadialGradient(
      canvasWidth * 0.46,
      canvasHeight * 0.42,
      Math.min(canvasWidth, canvasHeight) * 0.18,
      canvasWidth * 0.46,
      canvasHeight * 0.42,
      Math.max(canvasWidth, canvasHeight) * 0.74,
    );
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
    vignette.addColorStop(
      1,
      light ? "rgba(42, 54, 70, 0.04)" : "rgba(0, 2, 7, 0.3)",
    );
    context.fillStyle = vignette;
    context.fillRect(0, 0, canvasWidth, canvasHeight);
    return canvas;
  } catch {
    return null;
  }
}
