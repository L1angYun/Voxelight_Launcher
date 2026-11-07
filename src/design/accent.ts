export interface AccentScale {
  base: string;
  hover: string;
  active: string;
  soft: string;
  border: string;
  foreground: string;
  ink: string;
  indicator: string;
}

interface Oklch {
  l: number;
  c: number;
  h: number;
}

const DEFAULT_ACCENT = "#b4f17a";
// Revision 7, corrected edge coordinates: the darkest of 576 adjacent
// medians is (223,221.5,215.5), left of the full-mode Close control.
// Subtract four per channel and round down to an 8-bit color. Ink is unchanged.
// Evidence: E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-07/follow-ups/focus/recomputed-reference.json
const LIGHT_INDICATOR_COMPOSITE_REFERENCE = "#dbd9d3";

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function normalizeHex(value: string): string {
  const input = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(input)) return input;
  if (/^#[0-9a-f]{3}$/.test(input)) {
    return `#${input[1]}${input[1]}${input[2]}${input[2]}${input[3]}${input[3]}`;
  }
  return DEFAULT_ACCENT;
}

function channels(hex: string) {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
}

function linearize(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function delinearize(value: number) {
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

function oklchToHex({ l, c, h }: Oklch): string {
  const angle = (h * Math.PI) / 180;
  const a = c * Math.cos(angle);
  const b = c * Math.sin(angle);
  const lRoot = l + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = l - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = l - 0.0894841775 * a - 1.291485548 * b;
  const linear = [
    4.0767416621 * lRoot ** 3 - 3.3077115913 * mRoot ** 3 + 0.2309699292 * sRoot ** 3,
    -1.2684380046 * lRoot ** 3 + 2.6097574011 * mRoot ** 3 - 0.3413193965 * sRoot ** 3,
    -0.0041960863 * lRoot ** 3 - 0.7034186147 * mRoot ** 3 + 1.707614701 * sRoot ** 3,
  ];
  return `#${linear
    .map((channel) => Math.round(delinearize(channel) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function luminance(hex: string): number {
  const [r, g, b] = channels(normalizeHex(hex)).map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(first: string, second: string): number {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

function mix(first: string, second: string, amount: number): string {
  const a = channels(normalizeHex(first));
  const b = channels(normalizeHex(second));
  return `#${a
    .map((channel, index) =>
      Math.round((channel * amount + b[index] * (1 - amount)) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function readableAccent(base: string, oklch: Oklch, surfaces: string[], minimum: number, theme: "dark" | "light"): string {
  let result = base;
  for (let step = 1; step <= 100 && surfaces.some(surface => contrast(result, surface) < minimum); step++) {
    result = oklchToHex({ ...oklch, l: oklch.l + ((theme === "light" ? 0 : 1) - oklch.l) * step / 100 });
  }
  if (surfaces.some(surface => contrast(result, surface) < minimum)) return theme === "light" ? "#000000" : "#ffffff";
  return result;
}

export function buildAccentScale(color: string, theme: "dark" | "light"): AccentScale {
  const base = normalizeHex(color);
  const oklch = hexToOklch(base);
  const background = theme === "dark" ? "#0d141a" : "#f3f6ef";
  const hover = oklchToHex({
    ...oklch,
    l: clamp(oklch.l + (theme === "dark" ? 0.06 : -0.04)),
  });
  const active = oklchToHex({
    ...oklch,
    l: clamp(oklch.l + (theme === "dark" ? -0.06 : -0.1)),
  });
  const foreground = contrast("#101418", base) >= contrast("#ffffff", base) ? "#101418" : "#ffffff";
  const surfaces = theme === "light" ? ["#f3f1eb", "#faf9f5", "#eae7e0"] : ["#141516", "#242527", "#0d0f14"];
  // Signal fills retain the user's exact color. Text has a separate bounded
  // lightness search, tested against the lightest/darkest content surfaces.
  const ink = readableAccent(base, oklch, surfaces, 4.5, theme);
  const indicator = theme === "light"
    ? readableAccent(base, oklch, [...surfaces, LIGHT_INDICATOR_COMPOSITE_REFERENCE], 3, theme)
    : base;
  return {
    base,
    hover,
    active,
    soft: mix(base, background, 0.16),
    border: mix(base, background, 0.42),
    foreground,
    ink,
    indicator,
  };
}
