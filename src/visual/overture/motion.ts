export const OVERTURE_STAGE_MS = 830;
export const OVERTURE_STATIC_MS = 450;
export const OVERTURE_IRIS_BLADE_COUNT = 8;

export const WORLD_PARTICLE_BUDGET = {
  fireflies: 24,
  dust: 48,
  total: 72,
} as const;

export const WORLD_PARALLAX_DEPTHS = {
  far: 0.22,
  middle: 0.52,
  character: 0.82,
  foreground: 1,
} as const;

export const WORLD_CAMERA = {
  maxOffsetPx: 18,
  pushScale: 1.06,
  spring: { stiffness: 150, damping: 22 },
} as const;

export const WORLD_LIGHT_CYCLE_MS = 80_000;
export const WORLD_CANVAS_PIXEL_RATIO_MAX = 1.5;
