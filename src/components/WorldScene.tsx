// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef, useState } from "react";
import {
  advanceSpring,
  clamp,
  createSpring,
  snapSpring,
  type SpringTuning,
} from "../visual/glass/jelly";
import {
  WORLD_CAMERA,
  WORLD_CANVAS_PIXEL_RATIO_MAX,
  WORLD_PARTICLE_BUDGET,
} from "../visual/overture/motion";
import "./WorldScene.css";

export const CUBE_SIZE_PX = 24;
export const CUBE_PITCH_PX = 40;
export const CUBE_TOP_HEIGHT = 6;
export const CUBE_SIDE_WIDTH = 6;
export const CUBE_DEFAULT_OPACITY = 0.85;
export const CUBE_PULSE_MIN = 0.72;
export const CUBE_PULSE_MAX = 0.96;
export const CUBE_ACTIVE_BUDGET = 50;
export const CUBE_FLIP_DURATION_MS = 280;
export const CUBE_STAY_DURATION_MS = 1800;
export const CUBE_GLOW_RADIUS_PX = 10;
export const CUBE_GLOW_DURATION_MS = 800;
export const CUBE_TRIGGER_RADIUS_PX = 72;
export const CUBE_RIPPLE_FALLOFF_PX = 108;
export const CUBE_TRIGGER_DISTANCE_PX = 8;
export const CUBE_RETRIGGER_DELAY_MS = 240;
export const POINTER_SPRING: SpringTuning = { stiffness: 90, damping: 13 };

const CUBE_IDLE_MIN_WIDTH_FACTOR = 0.72;
const CUBE_ROTATION_RPM = 0.22;
const CUBE_ROTATION_RADIANS_PER_SECOND = (CUBE_ROTATION_RPM / 60) * Math.PI * 2;

export type WorldSceneState = "idle" | "preparing" | "running" | "error";

type WorldSceneProps = {
  state?: WorldSceneState;
  className?: string;
  progress?: number;
  paused?: boolean;
  onCameraFrame?: (pose: { x: number; y: number; scale: number }) => void;
};

type Rgba = {
  r: number;
  g: number;
  b: number;
  a: number;
};

type Palette = {
  light: boolean;
  base: Rgba;
  top: Rgba;
  side: Rgba;
  line: Rgba;
  accent: Rgba;
  accentWhite: Rgba;
  accentTop: Rgba;
  accentSide: Rgba;
  dust: Rgba;
};

type CubeCell = {
  x: number;
  y: number;
  rotation: number;
  rotationSpeed: number;
  phase: number;
  period: number;
  cooldownUntil: number;
  ripplePhase: number;
  rippleAmplitude: number;
};

type CubeMotion = {
  startedAt: number;
  reverseAt: number;
  finishAt: number;
  glowStart: number;
};

type Particle = {
  baseX: number;
  baseY: number;
  driftX: number;
  driftY: number;
  frequencyX: number;
  frequencyY: number;
  phaseX: number;
  phaseY: number;
  brightnessPhase: number;
  size: number;
  opacity: number;
  firefly: boolean;
};

type PointerGoal = {
  x: number;
  y: number;
  active: boolean;
};

const TWO_PI = Math.PI * 2;
const FALLBACK_ACCENT = "#b4f17a";
const DARK_BASE = "#08101a";
const LIGHT_BASE = "#f0f2f6";
const WHITE = "#ffffff";
const BLACK = "#000000";
const PARTICLE_SEED = 0x5eedf13e;
const CUBE_TRIGGERS_PER_FRAME = 4;
const CUBE_IDLE_REDRAW_CELLS = 160;

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    media.addListener?.(update);
    return () => {
      media.removeEventListener?.("change", update);
      media.removeListener?.(update);
    };
  }, [query]);

  return matches;
}

function parseColor(value: string, fallback: Rgba): Rgba {
  const text = value.trim().toLowerCase();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    const raw = hex[1];
    if (raw.length === 3) {
      return {
        r: Number.parseInt(`${raw[0]}${raw[0]}`, 16),
        g: Number.parseInt(`${raw[1]}${raw[1]}`, 16),
        b: Number.parseInt(`${raw[2]}${raw[2]}`, 16),
        a: 1,
      };
    }
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
      a: raw.length === 8 ? Number.parseInt(raw.slice(6, 8), 16) / 255 : 1,
    };
  }

  if (/^rgba?\(/i.test(text)) {
    const values = text.match(/[\d.]+%?/g);
    if (values && values.length >= 3) {
      const channel = (token: string) =>
        token.endsWith("%")
          ? (Number.parseFloat(token) / 100) * 255
          : Number.parseFloat(token);
      const alpha = (token: string | undefined) => {
        if (!token) return 1;
        const parsed = Number.parseFloat(token);
        return token.endsWith("%") ? parsed / 100 : parsed;
      };
      return {
        r: clamp(channel(values[0]), 0, 255),
        g: clamp(channel(values[1]), 0, 255),
        b: clamp(channel(values[2]), 0, 255),
        a: clamp(alpha(values[3]), 0, 1),
      };
    }
  }

  return fallback;
}

function color(hex: string): Rgba {
  return parseColor(hex, { r: 180, g: 241, b: 122, a: 1 });
}

function mixColor(from: Rgba, to: Rgba, amount: number): Rgba {
  const weight = clamp(amount, 0, 1);
  return {
    r: from.r + (to.r - from.r) * weight,
    g: from.g + (to.g - from.g) * weight,
    b: from.b + (to.b - from.b) * weight,
    a: from.a + (to.a - from.a) * weight,
  };
}

function rgba(value: Rgba, alpha = value.a): string {
  return `rgba(${Math.round(value.r)}, ${Math.round(value.g)}, ${Math.round(value.b)}, ${clamp(alpha, 0, 1).toFixed(3)})`;
}

function relativeLuminance(value: Rgba): number {
  const linear = [value.r, value.g, value.b].map((component) => {
    const normalized = component / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function readPalette(scene: HTMLElement): Palette {
  const style = getComputedStyle(scene);
  const themeHint = document.documentElement.dataset.theme === "light";
  const backgroundText = style.getPropertyValue("--bg-base").trim();
  const backgroundFallback = color(themeHint ? LIGHT_BASE : DARK_BASE);
  const base = parseColor(backgroundText, backgroundFallback);
  const light = themeHint || relativeLuminance(base) > 0.52;
  const accent = parseColor(
    style.getPropertyValue("--accent").trim(),
    color(FALLBACK_ACCENT),
  );
  const white = color(WHITE);
  const black = color(BLACK);
  const accentWhite = mixColor(accent, white, 0.1);

  return {
    light,
    base,
    top: mixColor(base, white, 0.25),
    side: mixColor(base, black, 0.2),
    line: mixColor(base, black, 0.38),
    accent,
    accentWhite,
    accentTop: mixColor(accentWhite, white, 0.25),
    accentSide: mixColor(accentWhite, black, 0.2),
    dust: mixColor(accent, white, light ? 0.58 : 0.72),
  };
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

function createParticles(): Particle[] {
  const random = seededRandom(PARTICLE_SEED);
  return Array.from({ length: WORLD_PARTICLE_BUDGET.total }, (_, index) => {
    const firefly = index < WORLD_PARTICLE_BUDGET.fireflies;
    return {
      baseX: 0.025 + random() * 0.95,
      baseY: 0.03 + random() * 0.94,
      driftX: 0.004 + random() * 0.024,
      driftY: 0.003 + random() * 0.021,
      frequencyX: 0.025 + random() * 0.06,
      frequencyY: 0.021 + random() * 0.054,
      phaseX: random() * TWO_PI,
      phaseY: random() * TWO_PI,
      brightnessPhase: random() * TWO_PI,
      size: firefly ? 1.8 + random() * 1.4 : 0.8 + random() * 0.8,
      opacity: firefly ? 0.48 + random() * 0.34 : 0.14 + random() * 0.2,
      firefly,
    };
  });
}

const PARTICLES = createParticles();

function createCubeCells(width: number, height: number): CubeCell[] {
  const columns = Math.ceil(width / CUBE_PITCH_PX) + 1;
  const rows = Math.ceil(height / CUBE_PITCH_PX) + 1;
  const cells: CubeCell[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const noise = Math.sin(column * 12.9898 + row * 78.233) * 43758.5453;
      const seed = noise - Math.floor(noise);
      const random = seededRandom(
        Math.imul(column + 1, 0x9e3779b1) ^ Math.imul(row + 1, 0x85ebca6b),
      );
      // The grid shares one angular velocity. A small diagonal phase offset
      // produces a coherent wave instead of independent random spinning.
      const diagonalIndex = column + row;
      const wavePhase = diagonalIndex * 0.22;
      cells.push({
        x: (column + 0.5) * CUBE_PITCH_PX,
        y: (row + 0.5) * CUBE_PITCH_PX,
        rotation: wavePhase + random() * 0.04,
        rotationSpeed: CUBE_ROTATION_RADIANS_PER_SECOND,
        phase: wavePhase + random() * 0.2,
        period: 10 + random() * 4,
        cooldownUntil: 0,
        ripplePhase: 0,
        rippleAmplitude: 0,
      });
    }
  }

  return cells;
}

function cubePulse(cell: CubeCell, now: number): number {
  const wave =
    0.5 + Math.sin((now / 1000 / cell.period) * TWO_PI + cell.phase) * 0.5;
  return CUBE_PULSE_MIN + (CUBE_PULSE_MAX - CUBE_PULSE_MIN) * wave;
}

function cubicBezierEase(progress: number): number {
  const x = clamp(progress, 0, 1);
  let low = 0;
  let high = 1;
  let middle = x;

  for (let index = 0; index < 9; index += 1) {
    middle = (low + high) / 2;
    const inverse = 1 - middle;
    const curveX =
      3 * inverse * inverse * middle * 0.25 +
      3 * inverse * middle * middle * 0.5 +
      middle * middle * middle;
    if (curveX < x) low = middle;
    else high = middle;
  }

  const inverse = 1 - middle;
  return (
    3 * inverse * inverse * middle +
    3 * inverse * middle * middle +
    middle * middle * middle
  );
}

function cubePose(
  motion: CubeMotion | undefined,
  now: number,
): { widthFactor: number; accent: boolean } {
  if (!motion) return { widthFactor: 1, accent: false };

  const halfFlip = CUBE_FLIP_DURATION_MS / 2;
  if (now < motion.reverseAt) {
    const elapsed = Math.max(0, now - motion.startedAt);
    if (elapsed < halfFlip) {
      return {
        widthFactor: 1 - cubicBezierEase(elapsed / halfFlip),
        accent: false,
      };
    }
    return {
      widthFactor: cubicBezierEase((elapsed - halfFlip) / halfFlip),
      accent: true,
    };
  }

  const reverseElapsed = Math.max(0, now - motion.reverseAt);
  if (reverseElapsed < halfFlip) {
    return {
      widthFactor: 1 - cubicBezierEase(reverseElapsed / halfFlip),
      accent: true,
    };
  }
  return {
    widthFactor: cubicBezierEase((reverseElapsed - halfFlip) / halfFlip),
    accent: false,
  };
}

function cubeRotation(cell: CubeCell, now: number): number {
  return cell.rotation + cell.rotationSpeed * (now / 1000);
}

function drawCubeFaces(
  context: CanvasRenderingContext2D,
  cell: CubeCell,
  width: number,
  rotation: number,
  front: Rgba,
  top: Rgba,
  side: Rgba,
  edge: Rgba,
  accentFace: boolean,
) {
  if (width <= 0.04) return;

  const ratio = clamp(width / CUBE_SIZE_PX, 0, 1);
  const half = width / 2;
  const frontLeft = cell.x - half;
  const frontTop = cell.y - CUBE_SIZE_PX / 2;
  const frontRight = cell.x + half;
  const frontBottom = frontTop + CUBE_SIZE_PX;
  const topHeight = CUBE_TOP_HEIGHT * (0.6 + ratio * 0.4);
  const sideDirection = Math.sin(rotation) >= 0 ? 1 : -1;
  const sideWidth =
    sideDirection *
    CUBE_SIDE_WIDTH *
    (0.6 + Math.abs(Math.sin(rotation)) * 0.4);
  const backTop = frontTop - topHeight;
  const backBottom = frontBottom - topHeight;

  context.strokeStyle = rgba(edge, accentFace ? 0.55 : 0.12);
  context.lineWidth = accentFace ? 0.55 : 0.3;

  context.beginPath();
  context.moveTo(frontRight, frontTop);
  context.lineTo(frontRight + sideWidth, backTop);
  context.lineTo(frontRight + sideWidth, backBottom);
  context.lineTo(frontRight, frontBottom);
  context.closePath();
  context.stroke();
  context.fillStyle = rgba(side);
  context.fill();

  context.beginPath();
  context.moveTo(frontLeft, frontTop);
  context.lineTo(frontRight, frontTop);
  context.lineTo(frontRight + sideWidth, backTop);
  context.lineTo(frontLeft + sideWidth, backTop);
  context.closePath();
  context.stroke();
  context.fillStyle = rgba(top);
  context.fill();

  context.beginPath();
  context.moveTo(frontLeft, frontTop);
  context.lineTo(frontRight, frontTop);
  context.lineTo(frontRight, frontBottom);
  context.lineTo(frontLeft, frontBottom);
  context.closePath();
  context.stroke();
  context.fillStyle = rgba(front);
  context.fillRect(frontLeft, frontTop, width, CUBE_SIZE_PX);
}

function clearCubeCell(context: CanvasRenderingContext2D, cell: CubeCell) {
  // The clear box must stay inside the cell pitch. A larger box erases the
  // neighbours that will not necessarily be repainted in the same dirty tile.
  const halfWidth = CUBE_SIZE_PX / 2 + CUBE_SIDE_WIDTH + 1;
  const top = CUBE_SIZE_PX / 2 + CUBE_TOP_HEIGHT + 1;
  const bottom = CUBE_SIZE_PX / 2 + 1;
  context.clearRect(
    cell.x - halfWidth,
    cell.y - top,
    halfWidth * 2,
    top + bottom,
  );
}

function drawCubeCell(
  context: CanvasRenderingContext2D,
  cell: CubeCell,
  palette: Palette,
  now: number,
  motion?: CubeMotion,
  pointerX?: number,
  pointerY?: number,
) {
  clearCubeCell(context, cell);
  const pose = cubePose(motion, now);
  const rotation = cubeRotation(cell, now);
  const facing = Math.abs(Math.cos(rotation));

  let rippleBoost = 0;
  let rippleTilt = 0;
  if (pointerX !== undefined && pointerY !== undefined) {
    const deltaX = cell.x - pointerX;
    const deltaY = cell.y - pointerY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    if (distance < CUBE_RIPPLE_FALLOFF_PX) {
      const falloff = 1 - distance / CUBE_RIPPLE_FALLOFF_PX;
      rippleBoost = falloff * falloff * 0.68;
      rippleTilt = falloff * 0.3;
    }
  }

  const idleWidth =
    CUBE_SIZE_PX *
    (CUBE_IDLE_MIN_WIDTH_FACTOR + facing * (1 - CUBE_IDLE_MIN_WIDTH_FACTOR));
  const pulse = cubePulse(cell, now);
  const opacity = pose.accent
    ? clamp(pulse + 0.16 + rippleBoost, CUBE_PULSE_MIN, 0.98)
    : clamp(pulse + rippleBoost, CUBE_PULSE_MIN, CUBE_PULSE_MAX);
  const tint = 0.08 + facing * 0.06 + rippleBoost * 0.24;
  const idleFront = mixColor(palette.base, palette.accent, tint);
  const idleTop = mixColor(idleFront, color(WHITE), 0.25);
  const idleSide = mixColor(idleFront, color(BLACK), 0.2);

  context.save();
  context.globalAlpha = opacity;
  drawCubeFaces(
    context,
    cell,
    idleWidth * pose.widthFactor * (1 + rippleTilt),
    rotation,
    pose.accent ? palette.accentWhite : idleFront,
    pose.accent ? palette.accentTop : idleTop,
    pose.accent ? palette.accentSide : idleSide,
    palette.accent,
    pose.accent,
  );

  context.globalAlpha = opacity * 0.22;
  context.fillStyle = rgba(palette.line);
  const sideDirection = Math.sin(rotation) >= 0 ? 1 : -1;
  context.fillRect(
    cell.x + CUBE_SIZE_PX / 2 + sideDirection * (CUBE_SIDE_WIDTH + 0.8),
    cell.y - CUBE_SIZE_PX / 2,
    1,
    CUBE_SIZE_PX + CUBE_TOP_HEIGHT,
  );
  context.restore();
}

function drawCubeLayer(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  cells: CubeCell[],
  palette: Palette,
  now: number,
) {
  context.clearRect(0, 0, width, height);
  for (const cell of cells) drawCubeCell(context, cell, palette, now);
}

function drawPulseShard(
  context: CanvasRenderingContext2D,
  cells: CubeCell[],
  palette: Palette,
  now: number,
  active: Map<CubeCell, CubeMotion>,
  cursor: number,
  pointerX?: number,
  pointerY?: number,
) {
  if (cells.length === 0) return cursor;
  let index = cursor % cells.length;
  let drawn = 0;

  while (drawn < CUBE_IDLE_REDRAW_CELLS && drawn < cells.length) {
    const cell = cells[index];
    if (!active.has(cell)) {
      let inRipple = false;
      if (pointerX !== undefined && pointerY !== undefined) {
        const deltaX = cell.x - pointerX;
        const deltaY = cell.y - pointerY;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        if (distance < CUBE_RIPPLE_FALLOFF_PX) inRipple = true;
      }
      if (!inRipple) drawCubeCell(context, cell, palette, now, undefined, pointerX, pointerY);
    }
    index = (index + 1) % cells.length;
    drawn += 1;
  }

  return index;
}

function drawGlowLayer(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: Palette,
  now: number,
  active: Map<CubeCell, CubeMotion>,
) {
  context.clearRect(0, 0, width, height);
  for (const [cell, motion] of active) {
    const elapsed = now - motion.glowStart;
    if (elapsed < 0 || elapsed >= CUBE_GLOW_DURATION_MS) continue;
    const fade = 1 - elapsed / CUBE_GLOW_DURATION_MS;
    const glow = context.createRadialGradient(
      cell.x,
      cell.y,
      0,
      cell.x,
      cell.y,
      CUBE_GLOW_RADIUS_PX,
    );
    glow.addColorStop(0, rgba(palette.accent, 0.6 * fade));
    glow.addColorStop(0.32, rgba(palette.accent, 0.3 * fade));
    glow.addColorStop(1, rgba(palette.accent, 0));
    context.fillStyle = glow;
    context.fillRect(
      cell.x - CUBE_GLOW_RADIUS_PX,
      cell.y - CUBE_GLOW_RADIUS_PX,
      CUBE_GLOW_RADIUS_PX * 2,
      CUBE_GLOW_RADIUS_PX * 2,
    );
  }
}

function drawParticles(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  palette: Palette,
  now: number,
) {
  context.clearRect(0, 0, width, height);
  const seconds = now / 1000;
  const themeScale = palette.light ? 0.64 : 1;

  context.save();
  context.fillStyle = rgba(palette.accent);
  context.shadowColor = rgba(palette.accent, 0.68);
  context.shadowBlur = 8;
  for (const particle of PARTICLES) {
    if (!particle.firefly) continue;
    const x =
      particle.baseX * width +
      Math.sin(seconds * particle.frequencyX + particle.phaseX) *
        particle.driftX *
        width;
    const y =
      particle.baseY * height +
      Math.cos(seconds * particle.frequencyY + particle.phaseY) *
        particle.driftY *
        height;
    context.globalAlpha =
      clamp(
        particle.opacity +
          Math.sin(seconds * 0.78 + particle.brightnessPhase) * 0.09,
        0.45,
        0.86,
      ) * themeScale;
    context.beginPath();
    context.arc(x, y, particle.size / 2, 0, TWO_PI);
    context.fill();
  }
  context.restore();

  context.save();
  context.fillStyle = rgba(palette.dust);
  for (const particle of PARTICLES) {
    if (particle.firefly) continue;
    const x =
      particle.baseX * width +
      Math.sin(seconds * particle.frequencyX + particle.phaseX) *
        particle.driftX *
        width;
    const y =
      particle.baseY * height +
      Math.cos(seconds * particle.frequencyY + particle.phaseY) *
        particle.driftY *
        height;
    context.globalAlpha =
      clamp(
        particle.opacity +
          Math.cos(seconds * 0.54 + particle.brightnessPhase) * 0.045,
        0.12,
        0.36,
      ) * themeScale;
    context.fillRect(
      x - particle.size / 2,
      y - particle.size / 2,
      particle.size,
      particle.size,
    );
  }
  context.globalAlpha = 1;
  context.restore();
}

export function WorldScene({
  state = "idle",
  className = "",
  progress = 0,
  paused: userPaused = false,
  onCameraFrame,
}: WorldSceneProps) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const cubeCanvasRef = useRef<HTMLCanvasElement>(null);
  const glowCanvasRef = useRef<HTMLCanvasElement>(null);
  const particleCanvasRef = useRef<HTMLCanvasElement>(null);
  const pointerGoal = useRef<PointerGoal>({ x: 0, y: 0, active: false });
  const pointerSpring = useRef({
    x: createSpring(0.5),
    y: createSpring(0.5),
  });
  const cameraSpring = useRef({
    x: createSpring(),
    y: createSpring(),
  });
  const cameraScaleSpring = useRef(createSpring(1));
  const onCameraFrameRef = useRef(onCameraFrame);
  const animationTimeRef = useRef(0);
  const previousAnimationFrameRef = useRef<number | null>(null);
  const cubeCellsRef = useRef<CubeCell[]>([]);
  const activeCubeMotionsRef = useRef(new Map<CubeCell, CubeMotion>());
  const cubeFieldSizeRef = useRef({ width: 0, height: 0 });
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const finePointer = useMediaQuery("(pointer: fine)");
  const finePointerRef = useRef(finePointer);
  const [pageVisible, setPageVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );
  const [inView, setInView] = useState(true);
  const normalizedProgress = clamp(progress, 0, 100);
  const paused = userPaused || !pageVisible || !inView;

  useEffect(() => {
    onCameraFrameRef.current = onCameraFrame;
  }, [onCameraFrame]);

  useEffect(() => {
    finePointerRef.current = finePointer;
    if (!finePointer && pointerGoal.current.active) {
      pointerGoal.current = { ...pointerGoal.current, active: false };
      if (sceneRef.current) {
        sceneRef.current.dataset.pointerActive = "false";
      }
    }
  }, [finePointer]);

  useEffect(() => {
    const update = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setInView(entry.isIntersecting);
    });
    observer.observe(scene);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !finePointer) return;

    const movePointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const bounds = scene.getBoundingClientRect();
      const inside =
        bounds.width > 0 &&
        bounds.height > 0 &&
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;
      pointerGoal.current = {
        x: clamp(event.clientX - bounds.left, 0, Math.max(1, bounds.width)),
        y: clamp(event.clientY - bounds.top, 0, Math.max(1, bounds.height)),
        active: inside,
      };
      scene.dataset.pointerActive = String(inside);
    };

    const leavePointer = () => {
      pointerGoal.current = { ...pointerGoal.current, active: false };
      scene.dataset.pointerActive = "false";
    };

    const documentRoot = document.documentElement;
    let lastSceneEventAt = -Infinity;
    const sceneMove = (event: PointerEvent) => {
      lastSceneEventAt = performance.now();
      movePointer(event);
    };
    const windowMove = (event: PointerEvent) => {
      if (performance.now() - lastSceneEventAt < 1) return;
      movePointer(event);
    };

    scene.addEventListener("pointermove", sceneMove, { passive: true });
    scene.addEventListener("pointerleave", leavePointer, { passive: true });
    scene.addEventListener("pointercancel", leavePointer, { passive: true });
    window.addEventListener("pointermove", windowMove, { passive: true });
    window.addEventListener("blur", leavePointer);
    documentRoot.addEventListener("pointerleave", leavePointer, {
      passive: true,
    });
    return () => {
      scene.removeEventListener("pointermove", sceneMove);
      scene.removeEventListener("pointerleave", leavePointer);
      scene.removeEventListener("pointercancel", leavePointer);
      window.removeEventListener("pointermove", windowMove);
      window.removeEventListener("blur", leavePointer);
      documentRoot.removeEventListener("pointerleave", leavePointer);
    };
  }, [finePointer]);

  useEffect(() => {
    const scene = sceneRef.current;
    const cubeCanvas = cubeCanvasRef.current;
    const glowCanvas = glowCanvasRef.current;
    const particleCanvas = particleCanvasRef.current;
    if (!scene || !cubeCanvas || !glowCanvas || !particleCanvas) return;

    let cubeContext: CanvasRenderingContext2D | null = null;
    let glowContext: CanvasRenderingContext2D | null = null;
    let particleContext: CanvasRenderingContext2D | null = null;
    try {
      cubeContext = cubeCanvas.getContext("2d");
      glowContext = glowCanvas.getContext("2d");
      particleContext = particleCanvas.getContext("2d");
    } catch {
      cubeContext = null;
      glowContext = null;
      particleContext = null;
    }

    let width = 1;
    let height = 1;
    let cells = cubeCellsRef.current;
    let palette = readPalette(scene);
    let frame: number | null = null;
    let pulseCursor = 0;
    let pointerWasActive = false;
    let triggerPoint = { x: 0, y: 0 };
    let needsInitialTrigger = false;
    const active = activeCubeMotionsRef.current;
    const motionEnabled = !paused && !reducedMotion;
    const scaleGoal =
      state === "preparing" || state === "running" ? WORLD_CAMERA.pushScale : 1;

    const resize = () => {
      const bounds = scene.getBoundingClientRect();
      width = Math.max(
        1,
        bounds.width || scene.clientWidth || cubeCanvas.clientWidth || 640,
      );
      height = Math.max(
        1,
        bounds.height || scene.clientHeight || cubeCanvas.clientHeight || 360,
      );
      const ratio = Math.min(
        typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
        WORLD_CANVAS_PIXEL_RATIO_MAX,
      );

      for (const canvas of [cubeCanvas, glowCanvas, particleCanvas]) {
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
      }
      for (const context of [cubeContext, glowContext, particleContext]) {
        context?.setTransform(ratio, 0, 0, ratio, 0, 0);
      }

      if (
        width !== cubeFieldSizeRef.current.width ||
        height !== cubeFieldSizeRef.current.height
      ) {
        cells = createCubeCells(width, height);
        cubeCellsRef.current = cells;
        cubeFieldSizeRef.current = { width, height };
        active.clear();
        pulseCursor = 0;
      }
      scene.dataset.cubeCount = String(cells.length);
      scene.dataset.activeFlips = String(active.size);
      cubeCanvas.dataset.rendered = "true";
      glowCanvas.dataset.rendered = "true";
      particleCanvas.dataset.rendered = "true";
    };

    const updateCamera = (x: number, y: number, scale: number) => {
      const cameraX = clamp(x, -1, 1);
      const cameraY = clamp(y, -1, 1);
      if (cameraRef.current) {
        cameraRef.current.style.transform = `translate3d(${(cameraX * WORLD_CAMERA.maxOffsetPx).toFixed(2)}px, ${(cameraY * WORLD_CAMERA.maxOffsetPx * 0.62).toFixed(2)}px, 0) scale(${scale.toFixed(4)})`;
      }
      onCameraFrameRef.current?.({ x: cameraX, y: cameraY, scale });
    };

    const paintFull = (now: number) => {
      if (cubeContext) {
        drawCubeLayer(cubeContext, width, height, cells, palette, now);
      }
      if (glowContext) {
        drawGlowLayer(glowContext, width, height, palette, now, active);
      }
      if (particleContext) {
        drawParticles(particleContext, width, height, palette, now);
      }
      scene.dataset.light = String(palette.light);
    };

    const triggerCubes = (now: number, x: number, y: number) => {
      const room = CUBE_ACTIVE_BUDGET - active.size;
      if (room <= 0) return;

      const radiusSquared = CUBE_TRIGGER_RADIUS_PX ** 2;
      const candidates: Array<{ cell: CubeCell; distance: number }> = [];
      for (const cell of cells) {
        if (active.has(cell) || now < cell.cooldownUntil) continue;
        const deltaX = cell.x - x;
        const deltaY = cell.y - y;
        const distance = deltaX * deltaX + deltaY * deltaY;
        if (distance <= radiusSquared) {
          candidates.push({ cell, distance });
        }
      }
      candidates.sort((left, right) => left.distance - right.distance);

      const count = Math.min(room, CUBE_TRIGGERS_PER_FRAME);
      for (
        let index = 0;
        index < count && index < candidates.length;
        index += 1
      ) {
        const cell = candidates[index].cell;
        active.set(cell, {
          startedAt: now,
          reverseAt: now + CUBE_FLIP_DURATION_MS + CUBE_STAY_DURATION_MS,
          finishAt: now + CUBE_FLIP_DURATION_MS * 2 + CUBE_STAY_DURATION_MS,
          glowStart: now + CUBE_FLIP_DURATION_MS,
        });
      }
    };

    const updateCubes = (now: number, pointerX?: number, pointerY?: number) => {
      if (!cubeContext) return;
      for (const [cell, motion] of active) {
        if (now >= motion.finishAt) {
          active.delete(cell);
          cell.cooldownUntil = now + CUBE_RETRIGGER_DELAY_MS;
          drawCubeCell(cubeContext, cell, palette, now, undefined, pointerX, pointerY);
        } else {
          drawCubeCell(cubeContext, cell, palette, now, motion, pointerX, pointerY);
        }
      }

      if (pointerX !== undefined && pointerY !== undefined) {
        for (const cell of cells) {
          if (active.has(cell)) continue;
          const deltaX = cell.x - pointerX;
          const deltaY = cell.y - pointerY;
          const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
          if (distance < CUBE_RIPPLE_FALLOFF_PX) {
            drawCubeCell(cubeContext, cell, palette, now, undefined, pointerX, pointerY);
          }
        }
      }

      pulseCursor = drawPulseShard(
        cubeContext,
        cells,
        palette,
        now,
        active,
        pulseCursor,
        pointerX,
        pointerY,
      );
      scene.dataset.activeFlips = String(active.size);
    };

    const paintAnimated = (now: number, deltaSeconds: number) => {
      const targetX = pointerGoal.current.active
        ? pointerGoal.current.x / width
        : 0.5;
      const targetY = pointerGoal.current.active
        ? pointerGoal.current.y / height
        : 0.5;
      const becameActive = pointerGoal.current.active && !pointerWasActive;
      pointerWasActive = pointerGoal.current.active;

      if (becameActive) {
        pointerSpring.current.x.goal = targetX;
        pointerSpring.current.y.goal = targetY;
        snapSpring(pointerSpring.current.x, targetX);
        snapSpring(pointerSpring.current.y, targetY);
        needsInitialTrigger = true;
      } else {
        pointerSpring.current.x.goal = targetX;
        pointerSpring.current.y.goal = targetY;
        advanceSpring(pointerSpring.current.x, deltaSeconds, POINTER_SPRING);
        advanceSpring(pointerSpring.current.y, deltaSeconds, POINTER_SPRING);
      }

      const smoothX = pointerSpring.current.x.position * width;
      const smoothY = pointerSpring.current.y.position * height;
      const pointerDistance = Math.hypot(
        smoothX - triggerPoint.x,
        smoothY - triggerPoint.y,
      );
      if (
        finePointerRef.current &&
        pointerGoal.current.active &&
        (needsInitialTrigger || pointerDistance > CUBE_TRIGGER_DISTANCE_PX)
      ) {
        triggerCubes(now, smoothX, smoothY);
        triggerPoint = { x: smoothX, y: smoothY };
        needsInitialTrigger = false;
      }

      cameraSpring.current.x.goal = pointerGoal.current.active
        ? clamp((pointerGoal.current.x / width - 0.5) * 2, -1, 1)
        : 0;
      cameraSpring.current.y.goal = pointerGoal.current.active
        ? clamp((pointerGoal.current.y / height - 0.5) * 2, -1, 1)
        : 0;
      cameraScaleSpring.current.goal = scaleGoal;
      advanceSpring(cameraSpring.current.x, deltaSeconds, POINTER_SPRING);
      advanceSpring(cameraSpring.current.y, deltaSeconds, POINTER_SPRING);
      advanceSpring(
        cameraScaleSpring.current,
        deltaSeconds,
        WORLD_CAMERA.spring,
      );

      const rippleX = finePointerRef.current && pointerGoal.current.active ? smoothX : undefined;
      const rippleY = finePointerRef.current && pointerGoal.current.active ? smoothY : undefined;
      updateCubes(now, rippleX, rippleY);
      if (glowContext) {
        drawGlowLayer(glowContext, width, height, palette, now, active);
      }
      if (particleContext) {
        drawParticles(particleContext, width, height, palette, now);
      }
      updateCamera(
        cameraSpring.current.x.position,
        cameraSpring.current.y.position,
        cameraScaleSpring.current.position,
      );
      scene.dataset.rippleActive = String(rippleX !== undefined && rippleY !== undefined);
    };

    const tick = (now: number) => {
      const previousFrame = previousAnimationFrameRef.current;
      const deltaSeconds =
        previousFrame === null
          ? 0
          : clamp((now - previousFrame) / 1000, 0, 0.08);
      previousAnimationFrameRef.current = now;
      animationTimeRef.current += deltaSeconds * 1000;
      paintAnimated(animationTimeRef.current, deltaSeconds);
      frame =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(tick)
          : null;
    };

    resize();
    paintFull(animationTimeRef.current);
    updateCamera(0, 0, scaleGoal);

    if (motionEnabled) {
      if (typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(tick);
      }
    } else {
      snapSpring(pointerSpring.current.x, 0.5);
      snapSpring(pointerSpring.current.y, 0.5);
      snapSpring(cameraSpring.current.x, 0);
      snapSpring(cameraSpring.current.y, 0);
      snapSpring(cameraScaleSpring.current, 1);
      updateCamera(0, 0, 1);
    }

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            resize();
            paintFull(animationTimeRef.current);
          });
    resizeObserver?.observe(scene);

    const themeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            palette = readPalette(scene);
            paintFull(animationTimeRef.current);
          });
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });

    return () => {
      previousAnimationFrameRef.current = null;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      if (frame !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frame);
      }
    };
  }, [paused, reducedMotion, state]);

  return (
    <div
      ref={sceneRef}
      className={`world-scene${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      data-motion={reducedMotion ? "reduced" : "full"}
      data-paused={paused ? "true" : "false"}
      data-scene-state={state}
      data-scene-progress={normalizedProgress}
      data-particle-budget={WORLD_PARTICLE_BUDGET.total}
      data-cube-pitch={CUBE_PITCH_PX}
      data-cube-size={CUBE_SIZE_PX}
      data-cube-budget={CUBE_ACTIVE_BUDGET}
      data-cube-active-budget={CUBE_ACTIVE_BUDGET}
      data-cube-flip-duration={CUBE_FLIP_DURATION_MS}
      data-cube-stay-duration={CUBE_STAY_DURATION_MS}
      data-cube-glow-radius={CUBE_GLOW_RADIUS_PX}
      data-cube-glow-duration={CUBE_GLOW_DURATION_MS}
      data-cube-trigger-radius={CUBE_TRIGGER_RADIUS_PX}
      data-cube-trigger-distance={CUBE_TRIGGER_DISTANCE_PX}
      data-cube-retrigger-delay={CUBE_RETRIGGER_DELAY_MS}
      data-cube-rotation="true"
      data-cube-rotation-rpm-min="0.18"
      data-cube-rotation-rpm-max="0.26"
      data-pointer-fine={finePointer}
      data-pointer-active="false"
    >
      <div ref={cameraRef} className="world-scene__camera">
        <canvas
          ref={cubeCanvasRef}
          className="world-scene__cube-canvas"
          aria-hidden="true"
        />
        <canvas
          ref={glowCanvasRef}
          className="world-scene__glow-canvas"
          aria-hidden="true"
        />
        <canvas
          ref={particleCanvasRef}
          className="world-scene__particle-canvas"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
