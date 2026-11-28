import { DEFAULT_ACCENT } from "./accent";
import { ACCENT_PRESETS } from "./accentPresets";
import { AMBIENT_PRESETS, type AmbientPalette } from "./ambientPresets";

interface Oklch {
  l: number;
  c: number;
  h: number;
}

const CHROMATIC_HUE_OFFSETS = [-26, 30, 158, 70] as const;
const NEUTRAL_HUE_OFFSETS = [0, 36, 195, -32] as const;

const THEME_CURVES = {
  dark: {
    l: [0.64, 0.56, 0.50, 0.54],
    cMult: [1.05, 0.92, 0.65, 0.75],
    cMin: [0.05, 0.045, 0.04, 0.04],
    cMax: [0.15, 0.13, 0.10, 0.11],
  },
  light: {
    l: [0.80, 0.75, 0.72, 0.77],
    cMult: [0.75, 0.65, 0.50, 0.55],
    cMin: [0.04, 0.035, 0.03, 0.03],
    cMax: [0.10, 0.09, 0.07, 0.08],
  },
} as const;

const GAMUT_CLIP_STEP = 0.004;

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHex(value?: string | null): string {
  if (typeof value !== "string") return DEFAULT_ACCENT;
  const input = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(input)) return input;
  if (/^#[0-9a-f]{3}$/.test(input)) {
    return `#${input[1]}${input[1]}${input[2]}${input[2]}${input[3]}${input[3]}`;
  }
  return DEFAULT_ACCENT;
}

function channels(hex: string): number[] {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
}

function linearize(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function delinearize(value: number): number {
  const clamped = clamp(value);
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function hexToOklch(hex: string): Oklch {
  const [r, g, b] = channels(hex).map(linearize);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bValue = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    c: Math.hypot(a, bValue),
    h: (Math.atan2(bValue, a) * 180) / Math.PI,
  };
}

function oklchToLinearRgb({ l, c, h }: Oklch): readonly [number, number, number] {
  const angle = (h * Math.PI) / 180;
  const a = c * Math.cos(angle);
  const b = c * Math.sin(angle);
  const lRoot = l + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = l - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = l - 0.0894841775 * a - 1.291485548 * b;
  const l3 = lRoot ** 3;
  const m3 = mRoot ** 3;
  const s3 = sRoot ** 3;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

function inLinearSrgbGamut([r, g, b]: readonly [number, number, number]): boolean {
  return r >= 0 && r <= 1 && g >= 0 && g <= 1 && b >= 0 && b <= 1;
}

function linearRgbToHex(linear: readonly [number, number, number]): string {
  return `#${linear
    .map((channel) => Math.round(delinearize(channel) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function oklchToGamutHex(l: number, initialC: number, h: number): string {
  let chroma = Math.max(0, initialC);
  let linear = oklchToLinearRgb({ l, c: chroma, h });
  while (chroma > 0 && !inLinearSrgbGamut(linear)) {
    chroma = Math.max(0, chroma - GAMUT_CLIP_STEP);
    linear = oklchToLinearRgb({ l, c: chroma, h });
  }
  return linearRgbToHex(linear);
}

/**
 * Derive a 4-stop ambient light-field palette from an accent color and theme.
 */
export function deriveAmbientPalette(accentHex: string, theme: "dark" | "light"): AmbientPalette {
  const normalized = normalizeHex(accentHex);
  const { c, h } = hexToOklch(normalized);
  const hueOffsets = c >= 0.05 ? CHROMATIC_HUE_OFFSETS : NEUTRAL_HUE_OFFSETS;
  const baseC = Math.max(c, 0.045);
  const curve = THEME_CURVES[theme];

  const colors = hueOffsets.map((offset, index) => {
    const targetC = clamp(baseC * curve.cMult[index], curve.cMin[index], curve.cMax[index]);
    return oklchToGamutHex(curve.l[index], targetC, h + offset);
  });

  return [colors[0], colors[1], colors[2], colors[3]];
}

/**
 * Resolve the ambient palette from a preset match (when accentSource is "custom")
 * or dynamically from the active accent color.
 */
export function resolveAmbientPalette(options: {
  accentSource?: string | null;
  accentColor?: string | null;
  theme?: "dark" | "light" | null;
}): AmbientPalette {
  const theme = options.theme === "light" ? "light" : "dark";
  if (options.accentSource === "custom") {
    const normalized = normalizeHex(options.accentColor);
    const preset = ACCENT_PRESETS.find((item) => item.hex.toLowerCase() === normalized);
    if (preset && AMBIENT_PRESETS[preset.id]) {
      return AMBIENT_PRESETS[preset.id][theme];
    }
  }
  return deriveAmbientPalette(options.accentColor ?? DEFAULT_ACCENT, theme);
}
