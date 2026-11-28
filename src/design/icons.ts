/**
 * The single source of icon geometry. `ICON` mirrors the `--icon-*` tokens in
 * `tokens.css`; every lucide icon in new UI code should be sized from here so
 * stroke width, optical alignment and hit areas stay in one system.
 */
export const ICON = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 24,
} as const;

export type IconSize = keyof typeof ICON;
export type IconPixels = (typeof ICON)[IconSize];

/** Every size a lucide icon may ship at; the CSS `svg.lucide` rules match. */
export const ICON_SIZES: readonly IconPixels[] = [12, 14, 16, 20, 24];

/** Optical stroke widths, mirrored by `--icon-stroke*` in tokens.css. */
export const ICON_STROKE = 1.5;
export const ICON_STROKE_SMALL = 1.25;
