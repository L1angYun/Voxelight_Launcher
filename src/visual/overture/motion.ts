export const OVERTURE_STAGE_MS = 830;
export const OVERTURE_STATIC_MS = 450;
export const OVERTURE_IRIS_BLADE_COUNT = 8;

export const WORLD_PARALLAX_DEPTHS = {
  far: 0.264,
  middle: 0.624,
  character: 0.984,
  foreground: 1.2,
} as const;

export const WORLD_CAMERA = {
  maxOffsetPx: 18,
  pushScale: 1.06,
  spring: { stiffness: 150, damping: 22 },
} as const;

export const WORLD_LIGHT_CYCLE_MS = 60_000;
export const WORLD_CANVAS_PIXEL_RATIO_MAX = 1.5;
