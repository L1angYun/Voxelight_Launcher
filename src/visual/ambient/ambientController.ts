import type { AmbientPalette } from "../../design/ambientPresets";

export const DRIFT_PERIODS_S = [38, 33, 29, 24] as const;
export const DRIFT_PHASES = [0, 1.7, 3.4, 5.1] as const;
export const BREATH_PERIODS_S = [26, 22, 30, 27] as const;
export const MAJOR_AXES_VMAX = [1.5, 1.2, 1.0, 0.9] as const;
export const ASPECT_RATIOS = [1.2, 1.32, 1.15, 1.28] as const;
/** First-frame defaults; tokens.css --ambient-peak-* carries the same values. */
export const PEAK_ALPHA = {
  dark: [0.66, 0.54, 0.46, 0.40],
  light: [0.48, 0.44, 0.40, 0.36],
} as const;
export const ANCHORS = [
  [0.22, 0.28],
  [0.78, 0.24],
  [0.72, 0.76],
  [0.28, 0.78],
] as const;
/**
 * Light fields multiply. Field 1 centred over the sky above Home's horizon
 * ridge darkened that sky more than the ridge and flattened the silhouette
 * (ui-language-spec 2.11.4, R3-4), so in light it orbits the ridge line
 * instead: its centre never rises above 38% of the viewport. tokens.css
 * --ambient-anchor-1 places the static field the same way.
 */
export const LIGHT_ANCHORS = [
  [0.22, 0.28],
  [0.78, 0.56],
  [0.72, 0.76],
  [0.28, 0.78],
] as const;
/** The y drift turns at 3/4 of the x drift rate. */
export const DRIFT_Y_RATE = 0.75;
/**
 * Seconds after which each field retraces its whole drift path: 4 x periods,
 * which are 3 y periods. A span of one drift period covers only part of it.
 */
export const DRIFT_ORBIT_PERIODS_S = [152, 132, 116, 96] as const;
/** Alpha stops of every field's radial sprite, from its centre (0) to its rim (1). */
export const SPRITE_STOPS = [
  [0, 1],
  [0.32, 0.72],
  [0.62, 0.26],
  [0.85, 0.06],
  [1, 0],
] as const;
export const ORBIT_X = [0.18, 0.20, 0.16, 0.15] as const;
export const ORBIT_Y = [0.16, 0.18, 0.21, 0.14] as const;
export const ROTATIONS = [0.28, -0.35, 0.45, -0.22] as const;
export const FPS_TIERS = [30, 20, 12, 0] as const;

export type AmbientTheme = "dark" | "light";
export type AmbientFpsTier = (typeof FPS_TIERS)[number];

export interface AmbientControllerConfig {
  enabled: boolean;
  theme: AmbientTheme;
  palette: AmbientPalette;
  intensity?: number;
  highContrast?: boolean;
  reducedMotion?: boolean;
  customBackgroundActive?: boolean;
}

export interface AmbientFieldState {
  index: number;
  x: number;
  y: number;
  rx: number;
  ry: number;
  rotation: number;
  alpha: number;
  color: string;
}

export interface AmbientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AmbientController {
  attachCanvas(canvas: HTMLCanvasElement | null): void;
  updateConfig(nextConfig: Partial<AmbientControllerConfig>): void;
  resize(vw: number, vh: number): void;
  setPaused(paused: boolean): void;
  start(): void;
  stop(): void;
  drawAt(nowMs: number): boolean;
  getBusyness(rect: AmbientRect): number;
  getFps(): AmbientFpsTier;
  dispose(): void;
}

const DEFAULT_INTENSITY = 0.6;
const SPRITE_SIZE = 256;
const SLOW_FRAME_THRESHOLD_MS = 2;
const SLOW_FRAME_CONSECUTIVE_LIMIT = 5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHexRgb(hex: string): readonly [number, number, number] {
  const clean = /^#[0-9a-f]{6}$/i.test(hex.trim()) ? hex.trim() : "#0078d4";
  return [
    Number.parseInt(clean.slice(1, 3), 16),
    Number.parseInt(clean.slice(3, 5), 16),
    Number.parseInt(clean.slice(5, 7), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const rgb = parseHexRgb(hex).map((channel) => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function buildSprite(hex: string): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
  const sprite = document.createElement("canvas");
  sprite.width = SPRITE_SIZE;
  sprite.height = SPRITE_SIZE;
  const ctx = sprite.getContext("2d");
  if (!ctx) return null;

  const [r, g, b] = parseHexRgb(hex);
  const half = SPRITE_SIZE / 2;
  const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
  for (const [offset, alpha] of SPRITE_STOPS) gradient.addColorStop(offset, `rgba(${r}, ${g}, ${b}, ${alpha})`);

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SPRITE_SIZE, SPRITE_SIZE);
  return sprite;
}

/**
 * The peak alphas of `theme`. The --ambient-peak tokens on <html> win only while
 * <html> already carries that theme: the layer's effects run before the
 * appearance provider writes data-theme, and :root always holds the dark
 * values, so reading them then would draw the previous theme's peaks.
 */
export function readPeakAlphas(
  theme: AmbientTheme,
): readonly [number, number, number, number] {
  const defaults = PEAK_ALPHA[theme];
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return defaults;
  }
  if (document.documentElement.dataset.theme !== theme) return defaults;
  const style = getComputedStyle(document.documentElement);
  const resolved = defaults.map((fallback, index) => {
    const raw = style.getPropertyValue(`--ambient-peak-${index}`).trim();
    if (!raw) return fallback;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : fallback;
  });
  return [resolved[0], resolved[1], resolved[2], resolved[3]];
}

/**
 * Compute downscaled ambient canvas backing dimensions (DPR = 1).
 */
export function computeAmbientCanvasSize(
  viewportWidth: number,
  viewportHeight: number,
): { width: number; height: number } {
  const width = Math.max(240, Math.min(480, Math.round(viewportWidth / 6)));
  const height = Math.max(
    135,
    Math.min(270, Math.round(width * (viewportHeight / Math.max(1, viewportWidth)))),
  );
  return { width, height };
}

/**
 * Compute analytical ambient light-field transforms and opacities at a given timestamp.
 */
export function computeFieldStates(
  timeMs: number,
  viewportWidth: number,
  viewportHeight: number,
  config: AmbientControllerConfig,
  peakAlphas?: readonly [number, number, number, number],
): AmbientFieldState[] {
  const count = viewportWidth < 1200 ? 3 : 4;
  const t = timeMs / 1000;
  const vmax = Math.max(1, viewportWidth, viewportHeight);
  const intensity = clamp(config.intensity ?? DEFAULT_INTENSITY, 0, 1);
  const theme = config.theme;
  const peaks = peakAlphas ?? PEAK_ALPHA[theme];
  const alphaFloor = theme === "dark" ? 0.72 : 0.78;
  const alphaSpan = 1 - alphaFloor;
  const anchors = theme === "light" ? LIGHT_ANCHORS : ANCHORS;
  const fields: AmbientFieldState[] = [];

  for (let i = 0; i < count; i++) {
    const phase = DRIFT_PHASES[i];
    const driftTheta = (2 * Math.PI * t) / DRIFT_PERIODS_S[i] + phase;
    const xNorm = anchors[i][0] + ORBIT_X[i] * Math.sin(driftTheta);
    const yNorm = anchors[i][1] + ORBIT_Y[i] * Math.cos(driftTheta * DRIFT_Y_RATE + phase * 0.5);

    const breathTheta = (2 * Math.PI * t) / BREATH_PERIODS_S[i] + phase * 0.7;
    const breathNorm = 0.5 + 0.5 * Math.cos(breathTheta);
    const radiusScale = 1 + 0.06 * (2 * breathNorm - 1);
    const alphaMod = alphaFloor + alphaSpan * breathNorm;

    const rx = 0.5 * MAJOR_AXES_VMAX[i] * vmax * radiusScale;
    const ry = rx / ASPECT_RATIOS[i];

    fields.push({
      index: i,
      x: xNorm * viewportWidth,
      y: yNorm * viewportHeight,
      rx,
      ry,
      rotation: ROTATIONS[i],
      alpha: clamp(peaks[i] * alphaMod * intensity, 0, 0.78),
      color: config.palette[i],
    });
  }

  return fields;
}

function samplePoints(rect: AmbientRect): ReadonlyArray<readonly [number, number]> {
  const cx = rect.left + rect.width * 0.5;
  const cy = rect.top + rect.height * 0.5;
  if (rect.width <= 0 || rect.height <= 0) {
    return [[cx, cy], [cx, cy], [cx, cy], [cx, cy], [cx, cy]];
  }
  const x1 = rect.left + rect.width * 0.15;
  const x2 = rect.left + rect.width * 0.85;
  const y1 = rect.top + rect.height * 0.15;
  const y2 = rect.top + rect.height * 0.85;
  return [
    [cx, cy],
    [x1, y1],
    [x2, y1],
    [x1, y2],
    [x2, y2],
  ];
}

export function createAmbientController(initialOptions: AmbientControllerConfig & {
  viewportWidth?: number;
  viewportHeight?: number;
}): AmbientController {
  let config: AmbientControllerConfig = {
    enabled: initialOptions.enabled,
    theme: initialOptions.theme,
    palette: [...initialOptions.palette] as AmbientPalette,
    intensity: initialOptions.intensity ?? DEFAULT_INTENSITY,
    highContrast: initialOptions.highContrast ?? false,
    reducedMotion: initialOptions.reducedMotion ?? false,
    customBackgroundActive: initialOptions.customBackgroundActive ?? false,
  };
  let viewportWidth = Math.max(1, initialOptions.viewportWidth ?? 1280);
  let viewportHeight = Math.max(1, initialOptions.viewportHeight ?? 720);
  let canvas: HTMLCanvasElement | null = null;
  let sprites: Array<HTMLCanvasElement | null> = [];
  let cachedPaletteKey = "";
  let fpsTierIndex = 0;
  let slowFrameCount = 0;
  let lastDrawAt: number | null = null;
  let lastFields: AmbientFieldState[] = [];
  let cachedPeakAlphas = readPeakAlphas(config.theme);
  let running = false;
  let paused = false;
  let disposed = false;
  let rafId: number | null = null;

  function ensureSprites() {
    const key = config.palette.join("|");
    if (key === cachedPaletteKey) return;
    cachedPaletteKey = key;
    sprites = config.palette.map((hex) => buildSprite(hex));
  }

  /** Returns true when the backing size changed, which also clears the bitmap. */
  function syncCanvasSize(): boolean {
    if (!canvas) return false;
    const { width, height } = computeAmbientCanvasSize(viewportWidth, viewportHeight);
    let changed = false;
    if (canvas.width !== width) {
      canvas.width = width;
      changed = true;
    }
    if (canvas.height !== height) {
      canvas.height = height;
      changed = true;
    }
    return changed;
  }

  function clearCanvas() {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function cancelFrame() {
    if (rafId !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafId);
    }
    rafId = null;
  }

  function canRunLoop(): boolean {
    return (
      !disposed &&
      running &&
      !paused &&
      config.enabled &&
      !config.highContrast &&
      !config.reducedMotion &&
      FPS_TIERS[fpsTierIndex] > 0
    );
  }

  function scheduleNextFrame() {
    if (!canRunLoop() || rafId !== null || typeof requestAnimationFrame !== "function") {
      return;
    }
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (!canRunLoop()) return;
      drawAt(performance.now());
      scheduleNextFrame();
    });
  }

  /** Paint one frame of the current config at `nowMs`. */
  function paint(nowMs: number) {
    ensureSprites();
    const fields = computeFieldStates(
      nowMs,
      viewportWidth,
      viewportHeight,
      config,
      cachedPeakAlphas,
    );
    lastFields = fields;

    if (canvas) {
      syncCanvasSize();
      const ctx = canvas.getContext("2d");
      if (ctx) {
        const sx = canvas.width / Math.max(1, viewportWidth);
        const sy = canvas.height / Math.max(1, viewportHeight);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = "source-over";
        for (const field of fields) {
          const sprite = sprites[field.index];
          if (!sprite) continue;
          ctx.save();
          ctx.globalAlpha = field.alpha;
          ctx.translate(field.x * sx, field.y * sy);
          ctx.rotate(field.rotation);
          ctx.scale(field.rx * sx, field.ry * sy);
          ctx.drawImage(sprite, -1, -1, 2, 2);
          ctx.restore();
        }
      }
    }
  }

  /**
   * While the loop is halted (paused for a running game or a hidden or
   * minimized window, or stopped by the adaptive tier reaching 0) the canvas
   * still shows the light. Repaint that still frame once, at the last drawn
   * time, whenever it would otherwise go blank, stretched or stale: a cleared
   * bitmap or a new viewport after a resize, a new canvas, or a theme, palette
   * or intensity change. No loop starts and no frame is timed.
   */
  function renderStill() {
    if (disposed || !canvas) return;
    if (!paused && FPS_TIERS[fpsTierIndex] > 0) return;
    if (!config.enabled || config.highContrast || config.reducedMotion) return;
    paint(lastDrawAt ?? performance.now());
  }

  function drawAt(nowMs: number): boolean {
    if (disposed) return false;
    const fps = FPS_TIERS[fpsTierIndex];
    if (fps <= 0) {
      cancelFrame();
      return false;
    }
    if (lastDrawAt !== null && nowMs >= lastDrawAt && nowMs - lastDrawAt < 1000 / fps) {
      return false;
    }

    lastDrawAt = nowMs;
    if (!config.enabled || config.highContrast) {
      lastFields = [];
      clearCanvas();
      return false;
    }

    const frameStart = performance.now();
    paint(nowMs);

    const frameDuration = performance.now() - frameStart;
    if (frameDuration > SLOW_FRAME_THRESHOLD_MS) {
      slowFrameCount += 1;
      if (slowFrameCount >= SLOW_FRAME_CONSECUTIVE_LIMIT) {
        fpsTierIndex = Math.min(FPS_TIERS.length - 1, fpsTierIndex + 1);
        slowFrameCount = 0;
        if (FPS_TIERS[fpsTierIndex] === 0) {
          running = false;
          cancelFrame();
        }
      }
    } else {
      slowFrameCount = 0;
    }

    return true;
  }

  return {
    attachCanvas(nextCanvas) {
      const replaced = nextCanvas !== canvas;
      canvas = nextCanvas;
      if (canvas) {
        const resized = syncCanvasSize();
        ensureSprites();
        if (replaced || resized) renderStill();
      }
    },

    updateConfig(nextConfig) {
      config = {
        ...config,
        ...nextConfig,
        palette: nextConfig.palette ? ([...nextConfig.palette] as AmbientPalette) : config.palette,
      };
      cachedPeakAlphas = readPeakAlphas(config.theme);
      ensureSprites();
      if (!config.enabled || config.highContrast) {
        lastFields = [];
        clearCanvas();
        cancelFrame();
      } else if (canRunLoop()) {
        scheduleNextFrame();
      } else {
        renderStill();
      }
    },

    resize(vw, vh) {
      const nextWidth = Math.max(1, vw);
      const nextHeight = Math.max(1, vh);
      const viewportChanged = nextWidth !== viewportWidth || nextHeight !== viewportHeight;
      viewportWidth = nextWidth;
      viewportHeight = nextHeight;
      // A new backing size clears the bitmap; a new viewport with the same
      // backing size would stretch the old frame. Either way a still canvas
      // is drawn again at the new size.
      const backingChanged = syncCanvasSize();
      if (backingChanged || viewportChanged) renderStill();
    },

    setPaused(nextPaused) {
      paused = nextPaused;
      if (paused) {
        cancelFrame();
      } else if (canRunLoop()) {
        scheduleNextFrame();
      }
    },

    start() {
      if (disposed) return;
      running = true;
      scheduleNextFrame();
    },

    stop() {
      running = false;
      cancelFrame();
    },

    drawAt,

    getBusyness(rect) {
      let base = 0;
      if (config.enabled && !config.highContrast) {
        const fields =
          lastFields.length > 0
            ? lastFields
            : computeFieldStates(
                lastDrawAt ?? 0,
                viewportWidth,
                viewportHeight,
                config,
                cachedPeakAlphas,
              );
        const points = samplePoints(rect);
        const coverages: number[] = [];
        const luminances: number[] = [];

        for (const [px, py] of points) {
          let complement = 1;
          let lumWeighted = 0;
          for (const field of fields) {
            const dx = px - field.x;
            const dy = py - field.y;
            const cos = Math.cos(-field.rotation);
            const sin = Math.sin(-field.rotation);
            const lx = (dx * cos - dy * sin) / Math.max(1, field.rx);
            const ly = (dx * sin + dy * cos) / Math.max(1, field.ry);
            const d2 = lx * lx + ly * ly;
            const contribution = clamp(field.alpha * Math.exp(-2.2 * d2), 0, 1);
            complement *= 1 - contribution;
            lumWeighted += contribution * relativeLuminance(field.color);
          }
          coverages.push(1 - complement);
          luminances.push(lumWeighted);
        }

        const meanCoverage = coverages.reduce((sum, v) => sum + v, 0) / coverages.length;
        const meanLum = luminances.reduce((sum, v) => sum + v, 0) / luminances.length;
        const lumVariance =
          luminances.reduce((sum, v) => sum + (v - meanLum) ** 2, 0) / luminances.length;
        base = clamp(meanCoverage * 0.75 + Math.sqrt(lumVariance) * 0.6, 0, 0.85);
      }

      const bgBoost = config.customBackgroundActive ? 0.2 : 0;
      return clamp(base + bgBoost, 0, 1);
    },

    getFps() {
      return FPS_TIERS[fpsTierIndex];
    },

    dispose() {
      disposed = true;
      running = false;
      cancelFrame();
      canvas = null;
      sprites = [];
      lastFields = [];
    },
  };
}

let activeAmbientController: AmbientController | null = null;
const ambientStateListeners = new Set<() => void>();

export function setActiveAmbientController(ctrl: AmbientController | null): void {
  activeAmbientController = ctrl;
}

/** The controller of the mounted AmbientLayer, or null while none is mounted. */
export function getActiveAmbientController(): AmbientController | null {
  return activeAmbientController;
}

export function getAmbientBusyness(rect: AmbientRect): number {
  return activeAmbientController ? activeAmbientController.getBusyness(rect) : 0;
}

export function subscribeAmbientState(listener: () => void): () => void {
  ambientStateListeners.add(listener);
  return () => {
    ambientStateListeners.delete(listener);
  };
}

export function notifyAmbientStateChanged(): void {
  for (const listener of [...ambientStateListeners]) {
    listener();
  }
}
