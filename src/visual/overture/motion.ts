export const OVERTURE_STAGE_MS = 830;
export const OVERTURE_STATIC_MS = 450;
export const OVERTURE_IRIS_BLADE_COUNT = 8;

export const WORLD_PARTICLE_BUDGET = {
  fireflies: 16,
  dust: 32,
  total: 48,
} as const;

export const WORLD_PARALLAX_DEPTHS = {
  far: 0.16,
  middle: 0.4,
  character: 0.72,
  foreground: 1,
} as const;

export const WORLD_CAMERA = {
  maxOffsetPx: 14,
  pushScale: 1.05,
  spring: { stiffness: 170, damping: 26 },
} as const;

export const WORLD_LIGHT_CYCLE_MS = 120_000;
export const WORLD_CANVAS_PIXEL_RATIO_MAX = 1.5;
