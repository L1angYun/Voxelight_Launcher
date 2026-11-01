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
} from "../visual/overture/motion";
import {
  CUBE_CELL_CLEAR_PX,
  CUBE_CANVAS_EDGE_GUARD_PX,
  CUBE_MAX_PROJECTION_HALF_PX,
  CUBE_PITCH_PX,
  CUBE_SIZE_PX,
  cubeProjection,
  cameraSweepToField,
  cubeSweepIntersects,
  paintCubeProjection,
  type CubeProjection,
  type Point2,
  type PointerSweep,
} from "./cubeGeometry";
import "./WorldScene.css";

export { CUBE_SIZE_PX, CUBE_PITCH_PX, cubeProjection } from "./cubeGeometry";
export const CUBE_DEFAULT_OPACITY = 0.74;
export const CUBE_PULSE_MIN = 0.58;
export const CUBE_PULSE_MAX = 0.84;
export const CUBE_FLIP_DURATION_MS = 1200;
export const CUBE_STAY_DURATION_MS = 1800;
export const CUBE_RETURN_DURATION_MS = 280;
export const CUBE_GLOW_RADIUS_PX = 10;
export const CUBE_GLOW_DURATION_MS = 800;
export const CUBE_TRIGGER_RADIUS_PX = 72;
export const CUBE_RIPPLE_FALLOFF_PX = 180;
export const CUBE_TRIGGER_DISTANCE_PX = 0;
export const CUBE_RETRIGGER_DELAY_MS = 240;
export const POINTER_SPRING: SpringTuning = { stiffness: 90, damping: 13 };

export const CUBE_ROTATION_RPM = 1.2;
const CUBE_ROTATION_RADIANS_PER_SECOND = (CUBE_ROTATION_RPM / 60) * Math.PI * 2;
export const CUBE_DIAGONAL_PHASE_RADIANS = 0.045;

export type WorldSceneState = "idle" | "preparing" | "running" | "error";

type WorldSceneProps = {
  state?: WorldSceneState;
  className?: string;
  progress?: number;
  paused?: boolean;
  effects?: "full" | "lite";
  reducedMotion?: boolean;
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
  accent: Rgba;
  accentWhite: Rgba;
};

type CubeCell = {
  x: number;
  y: number;
  rotation: number;
  rotationSpeed: number;
  phase: number;
  period: number;
  cooldownUntil: number;
  pointerInside: boolean;
};

type CubeMotion = {
  startedAt: number;
  fadeAt: number;
  finishAt: number;
  glowStart: number;
  accentFrom: number;
  pendingTurn: boolean;
};

type PointerGoal = {
  x: number;
  y: number;
  active: boolean;
};
type FieldPointerSweep = PointerSweep & {
  radius: number;
  startsNewPath: boolean;
};

const TWO_PI = Math.PI * 2;
const FALLBACK_ACCENT = "#b4f17a";
const DARK_BASE = "#08101a";
const LIGHT_BASE = "#f0f2f6";
const WHITE = "#ffffff";
const BLACK = "#000000";
const WHITE_COLOR = color(WHITE);
const BLACK_COLOR = color(BLACK);
const WORLD_CAMERA_VERTICAL_RATIO = 0.62;

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
  const accentWhite = mixColor(accent, WHITE_COLOR, 0.1);

  return {
    light,
    base,
    accent,
    accentWhite,
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

function createCubeCells(width: number, height: number): CubeCell[] {
  const maxScale = WORLD_CAMERA.pushScale;
  // Reserve the complete solid envelope even at the camera's worst push and
  // translation. Remaining space is centered, so no partial edge cubes exist.
  const inset = (length: number, offset: number) =>
    CUBE_MAX_PROJECTION_HALF_PX +
    (offset + (length * (maxScale - 1)) / 2 + CUBE_CANVAS_EDGE_GUARD_PX) /
      maxScale;
  const safeX = inset(width, WORLD_CAMERA.maxOffsetPx);
  const safeY = inset(
    height,
    WORLD_CAMERA.maxOffsetPx * WORLD_CAMERA_VERTICAL_RATIO,
  );
  const columns = Math.max(
    0,
    Math.floor((width - safeX * 2) / CUBE_PITCH_PX) + 1,
  );
  const rows = Math.max(
    0,
    Math.floor((height - safeY * 2) / CUBE_PITCH_PX) + 1,
  );
  const firstX = (width - (columns - 1) * CUBE_PITCH_PX) / 2;
  const firstY = (height - (rows - 1) * CUBE_PITCH_PX) / 2;
  const cells: CubeCell[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const random = seededRandom(
        Math.imul(column + 1, 0x9e3779b1) ^ Math.imul(row + 1, 0x85ebca6b),
      );
      // The grid shares one angular velocity. A small diagonal phase offset
      // produces a coherent wave instead of independent random spinning.
      const diagonalIndex = column + row;
      const wavePhase = diagonalIndex * CUBE_DIAGONAL_PHASE_RADIANS;
      cells.push({
        x: firstX + column * CUBE_PITCH_PX,
        y: firstY + row * CUBE_PITCH_PX,
        rotation: Math.PI / 6 + wavePhase,
        rotationSpeed: CUBE_ROTATION_RADIANS_PER_SECOND,
        phase: wavePhase + random() * 0.2,
        period: 10 + random() * 4,
        cooldownUntil: 0,
        pointerInside: false,
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
  if (x === 0 || x === 1) return x;
  let low = 0;
  let high = 1;
  let parameter = x;
  // Existing --ease-in-out token: cubic-bezier(0.77, 0, 0.175, 1).
  for (let index = 0; index < 16; index += 1) {
    parameter = (low + high) / 2;
    const inverse = 1 - parameter;
    const curveX =
      3 * inverse * inverse * parameter * 0.77 +
      3 * inverse * parameter * parameter * 0.175 +
      parameter ** 3;
    if (curveX < x) low = parameter;
    else high = parameter;
  }
  return 3 * (1 - parameter) * parameter ** 2 + parameter ** 3;
}

export function cubeTurnOffset(elapsed: number): number {
  return TWO_PI * cubicBezierEase(elapsed / CUBE_FLIP_DURATION_MS);
}

function cubePose(motion: CubeMotion | undefined, now: number) {
  if (!motion) return { rotationOffset: 0, accent: 0 };
  const elapsed = Math.max(0, now - motion.startedAt);
  return {
    rotationOffset: cubeTurnOffset(elapsed),
    accent:
      now < motion.fadeAt
        ? motion.accentFrom +
          (1 - motion.accentFrom) * clamp(elapsed / 160, 0, 1)
        : 1 - clamp((now - motion.fadeAt) / CUBE_RETURN_DURATION_MS, 0, 1),
  };
}

function createCubeMotion(now: number, accentFrom = 0): CubeMotion {
  const fadeAt = now + CUBE_FLIP_DURATION_MS + CUBE_STAY_DURATION_MS;
  return {
    startedAt: now,
    fadeAt,
    finishAt: fadeAt + CUBE_RETURN_DURATION_MS,
    glowStart: now + CUBE_FLIP_DURATION_MS,
    accentFrom,
    pendingTurn: false,
  };
}

function cubeRotation(cell: CubeCell, now: number): number {
  return cell.rotation + cell.rotationSpeed * (now / 1000);
}

function clearCubeCell(context: CanvasRenderingContext2D, cell: CubeCell) {
  const half = CUBE_CELL_CLEAR_PX / 2;
  context.clearRect(
    cell.x - half,
    cell.y - half,
    CUBE_CELL_CLEAR_PX,
    CUBE_CELL_CLEAR_PX,
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
  pointerStrength = 1,
  projection?: CubeProjection,
) {
  clearCubeCell(context, cell);
  const pose = cubePose(motion, now);
  const rotation = cubeRotation(cell, now) + pose.rotationOffset;
  const facing = Math.abs(Math.cos(rotation));

  let rippleBoost = 0;
  if (pointerStrength > 0 && pointerX !== undefined && pointerY !== undefined) {
    const deltaX = cell.x - pointerX;
    const deltaY = cell.y - pointerY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    if (distance < CUBE_RIPPLE_FALLOFF_PX) {
      const falloff =
        (1 - distance / CUBE_RIPPLE_FALLOFF_PX) * clamp(pointerStrength, 0, 1);
      rippleBoost = falloff * falloff * 0.68;
    }
  }

  const pulse = cubePulse(cell, now);
  const opacity = clamp(
    pulse + pose.accent * 0.2 + rippleBoost * (0.55 + pose.accent * 0.45),
    CUBE_PULSE_MIN,
    0.98 + pose.accent * 0.02,
  );
  const tint = 0.06 + facing * 0.16 + rippleBoost * 0.45;
  const idleFront = mixColor(palette.base, palette.accent, tint);
  const front = mixColor(idleFront, palette.accentWhite, pose.accent);
  const top = mixColor(front, WHITE_COLOR, 0.34);
  const side = mixColor(front, BLACK_COLOR, 0.32);

  context.save();
  context.globalAlpha = opacity;
  paintCubeProjection(
    context,
    projection ?? cubeProjection(rotation),
    cell,
    (light) => rgba(mixColor(side, top, light)),
  );
  context.restore();
}

function drawCubeLayer(
  context: CanvasRenderingContext2D,
  cells: CubeCell[],
  palette: Palette,
  now: number,
  active: Map<CubeCell, CubeMotion> = new Map(),
  pointerX?: number,
  pointerY?: number,
  pointerStrength = 0,
) {
  const projections = new Map<number, CubeProjection>();
  for (const cell of cells) {
    const motion = active.get(cell);
    const angle =
      cubeRotation(cell, now) + cubePose(motion, now).rotationOffset;
    let projection = projections.get(angle);
    if (!projection) {
      projection = cubeProjection(angle);
      projections.set(angle, projection);
    }
    drawCubeCell(
      context,
      cell,
      palette,
      now,
      motion,
      pointerX,
      pointerY,
      pointerStrength,
      projection,
    );
  }
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

export function WorldScene({
  state = "idle",
  className = "",
  progress = 0,
  paused: userPaused = false,
  effects,
  reducedMotion: requestedReducedMotion = false,
  onCameraFrame,
}: WorldSceneProps) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<HTMLDivElement>(null);
  const cubeCanvasRef = useRef<HTMLCanvasElement>(null);
  const glowCanvasRef = useRef<HTMLCanvasElement>(null);
  const pointerGoal = useRef<PointerGoal>({ x: 0, y: 0, active: false });
  const pointerSpring = useRef({
    x: createSpring(0.5),
    y: createSpring(0.5),
  });
  const pointerInfluence = useRef(createSpring());
  const cameraSpring = useRef({
    x: createSpring(),
    y: createSpring(),
  });
  const cameraScaleSpring = useRef(createSpring(1));
  const cameraPoseRef = useRef({ x: 0, y: 0, scale: 1 });
  const pointerPathRef = useRef<{
    last: Point2 | null;
    sweeps: FieldPointerSweep[];
  }>({ last: null, sweeps: [] });
  const onCameraFrameRef = useRef(onCameraFrame);
  const animationTimeRef = useRef(0);
  const previousAnimationFrameRef = useRef<number | null>(null);
  const cubeCellsRef = useRef<CubeCell[]>([]);
  const activeCubeMotionsRef = useRef(new Map<CubeCell, CubeMotion>());
  const cubeFieldSizeRef = useRef({ width: 0, height: 0 });
  const systemReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const reducedMotion =
    requestedReducedMotion || systemReducedMotion || effects === "lite";
  const finePointer = useMediaQuery("(any-pointer: fine)");
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

    const seenEvents = new WeakSet<PointerEvent>();
    const movePointer = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (seenEvents.has(event)) return;
      seenEvents.add(event);
      const bounds = scene.getBoundingClientRect();
      const path = pointerPathRef.current;
      const samples = event.getCoalescedEvents?.() ?? [];
      for (const sample of [...samples, event]) {
        const local = {
          x: sample.clientX - bounds.left,
          y: sample.clientY - bounds.top,
        };
        const camera = cameraPoseRef.current;
        if (!reducedMotion && !paused) {
          path.sweeps.push({
            ...cameraSweepToField(
              { from: path.last ?? local, to: local },
              bounds,
              camera,
              CUBE_TRIGGER_RADIUS_PX,
            ),
            startsNewPath: path.last === null,
          });
        }
        if (!reducedMotion && !paused) path.last = local;
      }
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
      pointerPathRef.current.last = null;
      for (const cell of cubeCellsRef.current) cell.pointerInside = false;
      scene.dataset.pointerActive = "false";
    };

    const documentRoot = document.documentElement;
    scene.addEventListener("pointermove", movePointer, { passive: true });
    scene.addEventListener("pointerleave", leavePointer, { passive: true });
    scene.addEventListener("pointercancel", leavePointer, { passive: true });
    window.addEventListener("pointermove", movePointer, { passive: true });
    window.addEventListener("blur", leavePointer);
    documentRoot.addEventListener("pointerleave", leavePointer, {
      passive: true,
    });
    return () => {
      scene.removeEventListener("pointermove", movePointer);
      scene.removeEventListener("pointerleave", leavePointer);
      scene.removeEventListener("pointercancel", leavePointer);
      window.removeEventListener("pointermove", movePointer);
      window.removeEventListener("blur", leavePointer);
      documentRoot.removeEventListener("pointerleave", leavePointer);
    };
  }, [finePointer, reducedMotion, paused]);

  useEffect(() => {
    const scene = sceneRef.current;
    const cubeCanvas = cubeCanvasRef.current;
    const glowCanvas = glowCanvasRef.current;
    if (!scene || !cubeCanvas || !glowCanvas) return;

    let cubeContext: CanvasRenderingContext2D | null = null;
    let glowContext: CanvasRenderingContext2D | null = null;
    try {
      cubeContext = cubeCanvas.getContext("2d");
      glowContext = glowCanvas.getContext("2d");
    } catch {
      cubeContext = null;
      glowContext = null;
    }

    let width = 1;
    let height = 1;
    let cells = cubeCellsRef.current;
    let palette = readPalette(scene);
    let frame: number | null = null;
    let pointerWasActive = pointerGoal.current.active;
    const active = activeCubeMotionsRef.current;
    const motionEnabled = !paused && !reducedMotion;
    if (!motionEnabled) {
      pointerPathRef.current.last = null;
      pointerPathRef.current.sweeps.length = 0;
      for (const cell of cells) cell.pointerInside = false;
    }
    if (reducedMotion) active.clear();
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

      for (const canvas of [cubeCanvas, glowCanvas]) {
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
      }
      for (const context of [cubeContext, glowContext]) {
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
      }
      scene.dataset.cubeCount = String(cells.length);
      scene.dataset.activeFlips = String(active.size);
      // Natural bound: every rendered cell may respond to the same sweep.
      scene.dataset.cubeActiveBudget = String(cells.length);
      scene.dataset.cubeBudget = String(cells.length);
      cubeCanvas.dataset.rendered = "true";
      glowCanvas.dataset.rendered = "true";
    };

    const updateCamera = (x: number, y: number, scale: number) => {
      const cameraX = clamp(x, -1, 1);
      const cameraY = clamp(y, -1, 1);
      const cameraScale = clamp(scale, 1, WORLD_CAMERA.pushScale);
      cameraPoseRef.current = {
        x: cameraX * WORLD_CAMERA.maxOffsetPx,
        y: cameraY * WORLD_CAMERA.maxOffsetPx * WORLD_CAMERA_VERTICAL_RATIO,
        scale: cameraScale,
      };
      if (cameraRef.current) {
        cameraRef.current.style.transform = `translate3d(${cameraPoseRef.current.x.toFixed(2)}px, ${cameraPoseRef.current.y.toFixed(2)}px, 0) scale(${cameraScale.toFixed(4)})`;
      }
      onCameraFrameRef.current?.({
        x: cameraX,
        y: cameraY,
        scale: cameraScale,
      });
    };

    const paintFull = (now: number) => {
      if (cubeContext) {
        const showRipple =
          !reducedMotion &&
          finePointerRef.current &&
          pointerInfluence.current.position > 0.01;
        drawCubeLayer(
          cubeContext,
          cells,
          palette,
          now,
          active,
          showRipple ? pointerSpring.current.x.position * width : undefined,
          showRipple ? pointerSpring.current.y.position * height : undefined,
          showRipple ? pointerInfluence.current.position : 0,
        );
      }
      if (glowContext) {
        drawGlowLayer(glowContext, width, height, palette, now, active);
      }
      scene.dataset.light = String(palette.light);
    };

    const triggerCubes = (now: number, sweeps: FieldPointerSweep[]) => {
      if (sweeps.length === 0 || !finePointerRef.current) return;
      const projections = new Map<number, CubeProjection>();
      for (const cell of cells) {
        const current = active.get(cell);
        const angle =
          cubeRotation(cell, now) + cubePose(current, now).rotationOffset;
        let projection = projections.get(angle);
        if (!projection) {
          projection = cubeProjection(angle);
          projections.set(angle, projection);
        }
        for (const sweep of sweeps) {
          if (sweep.startsNewPath) cell.pointerInside = false;
          const crossed = cubeSweepIntersects(
            sweep,
            cell,
            projection,
            sweep.radius,
          );
          const entered = crossed && !cell.pointerInside;
          cell.pointerInside = cubeSweepIntersects(
            { from: sweep.to, to: sweep.to },
            cell,
            projection,
            sweep.radius,
          );
          if (!entered || now < cell.cooldownUntil) continue;
          const motion = active.get(cell);
          if (motion && now < motion.startedAt + CUBE_FLIP_DURATION_MS) {
            // One pending revolution is enough to preserve a fresh entry while
            // preventing a stationary pointer or rapid samples from looping.
            if (motion.pendingTurn) continue;
            motion.pendingTurn = true;
          } else {
            active.set(
              cell,
              createCubeMotion(now, cubePose(motion, now).accent),
            );
          }
          cell.cooldownUntil = now + CUBE_RETRIGGER_DELAY_MS;
        }
        if (!pointerGoal.current.active) cell.pointerInside = false;
      }
    };

    const updateCubes = (
      now: number,
      pointerX?: number,
      pointerY?: number,
      pointerStrength = 1,
    ) => {
      for (const [cell, previousMotion] of active) {
        let motion = previousMotion;
        if (
          motion.pendingTurn &&
          now >= motion.startedAt + CUBE_FLIP_DURATION_MS
        ) {
          const nextStart = motion.startedAt + CUBE_FLIP_DURATION_MS;
          motion = createCubeMotion(
            nextStart,
            cubePose(motion, nextStart).accent,
          );
          active.set(cell, motion);
        }
        if (now >= motion.finishAt) active.delete(cell);
      }
      const sweeps = pointerPathRef.current.sweeps.splice(0);
      triggerCubes(now, sweeps);
      if (cubeContext) {
        drawCubeLayer(
          cubeContext,
          cells,
          palette,
          now,
          active,
          pointerX,
          pointerY,
          pointerStrength,
        );
      }
      scene.dataset.activeFlips = String(active.size);
      scene.dataset.cubeFrameTime = String(now);
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
        snapSpring(pointerInfluence.current, 1);
      } else {
        pointerSpring.current.x.goal = pointerGoal.current.active
          ? targetX
          : pointerSpring.current.x.position;
        pointerSpring.current.y.goal = pointerGoal.current.active
          ? targetY
          : pointerSpring.current.y.position;
        advanceSpring(pointerSpring.current.x, deltaSeconds, POINTER_SPRING);
        advanceSpring(pointerSpring.current.y, deltaSeconds, POINTER_SPRING);
        pointerInfluence.current.goal = pointerGoal.current.active ? 1 : 0;
        advanceSpring(pointerInfluence.current, deltaSeconds, POINTER_SPRING);
      }

      const smoothX = pointerSpring.current.x.position * width;
      const smoothY = pointerSpring.current.y.position * height;
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

      const pointerStrength = pointerInfluence.current.position;
      const rippleVisible = finePointerRef.current && pointerStrength > 0.01;
      const rippleX = rippleVisible ? smoothX : undefined;
      const rippleY = rippleVisible ? smoothY : undefined;
      updateCubes(now, rippleX, rippleY, pointerStrength);
      if (glowContext) {
        drawGlowLayer(glowContext, width, height, palette, now, active);
      }
      updateCamera(
        cameraSpring.current.x.position,
        cameraSpring.current.y.position,
        cameraScaleSpring.current.position,
      );
      scene.dataset.rippleActive = String(
        rippleX !== undefined && rippleY !== undefined,
      );
    };

    const tick = (now: number) => {
      const previousFrame = previousAnimationFrameRef.current;
      const elapsedSeconds =
        previousFrame === null ? 0 : Math.max(0, (now - previousFrame) / 1000);
      const physicsDelta = clamp(elapsedSeconds, 0, 0.08);
      previousAnimationFrameRef.current = now;
      animationTimeRef.current += elapsedSeconds * 1000;
      paintAnimated(animationTimeRef.current, physicsDelta);
      frame =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame(tick)
          : null;
    };

    resize();
    paintFull(animationTimeRef.current);
    updateCamera(
      cameraSpring.current.x.position,
      cameraSpring.current.y.position,
      cameraScaleSpring.current.position,
    );

    if (motionEnabled) {
      if (typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(tick);
      }
    } else if (reducedMotion) {
      snapSpring(pointerSpring.current.x, 0.5);
      snapSpring(pointerSpring.current.y, 0.5);
      snapSpring(pointerInfluence.current, 0);
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
      data-cube-pitch={CUBE_PITCH_PX}
      data-cube-size={CUBE_SIZE_PX}
      data-cube-flip-duration={CUBE_FLIP_DURATION_MS}
      data-cube-stay-duration={CUBE_STAY_DURATION_MS}
      data-cube-return-duration={CUBE_RETURN_DURATION_MS}
      data-cube-glow-radius={CUBE_GLOW_RADIUS_PX}
      data-cube-glow-duration={CUBE_GLOW_DURATION_MS}
      data-cube-trigger-radius={CUBE_TRIGGER_RADIUS_PX}
      data-cube-ripple-falloff={CUBE_RIPPLE_FALLOFF_PX}
      data-cube-trigger-distance={CUBE_TRIGGER_DISTANCE_PX}
      data-cube-retrigger-delay={CUBE_RETRIGGER_DELAY_MS}
      data-cube-rotation="true"
      data-cube-rotation-rpm={CUBE_ROTATION_RPM}
      data-cube-rotation-rpm-min={CUBE_ROTATION_RPM}
      data-cube-rotation-rpm-max={CUBE_ROTATION_RPM}
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
      </div>
    </div>
  );
}
