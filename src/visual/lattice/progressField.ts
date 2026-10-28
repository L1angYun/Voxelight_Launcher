import { clamp } from "../glass/jelly";
import { DOT_FRAME_LIMIT_SECONDS, DotField, seededRandom, type DotSpring } from "./dots";

export type ProgressMode = "determinate" | "scan";

export interface ProgressPalette {
  gas: string;
  solid: string;
  flash: string;
}

export interface ProgressContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  clearRect(x: number, y: number, width: number, height: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, start: number, end: number): void;
  fill(): void;
}

export const PROGRESS_ROWS = 3;
export const PROGRESS_COLUMN_PITCH_PX = 7;
export const PROGRESS_ROW_PITCH_PX = 5;
export const PROGRESS_MIN_COLUMNS = 10;
export const PROGRESS_MAX_COLUMNS = 240;
export const PROGRESS_FIELD_HEIGHT_PX = 32;
export const PROGRESS_GAS_SPRING: DotSpring = { stiffness: 14, damping: 4.5 };
export const PROGRESS_LOCK_SPRING: DotSpring = { stiffness: 60, damping: 8 };
export const PROGRESS_GAS_ALPHA = 0.34;
export const PROGRESS_GAS_RADIUS_PX = 1.25;
export const PROGRESS_SOLID_RADIUS_PX = 1.5;

const GAS_SPREAD_COLUMNS = 6;
const GAS_SPREAD_HEIGHT = 0.3;
const EASE_PER_SECOND = 6;
const FLASH_DECAY_PER_SECOND = 2.2;
const FLASH_VISIBLE = 0.35;
const LOCK_DISTANCE_PX = 0.8;
const SCAN_SPEED = 0.45;
const SCAN_HALF_WIDTH = 0.12;

export function progressColumns(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return PROGRESS_MIN_COLUMNS;
  return clamp(Math.floor(width / PROGRESS_COLUMN_PITCH_PX), PROGRESS_MIN_COLUMNS, PROGRESS_MAX_COLUMNS);
}

/** A column counts as built only when its whole share of the work is done, so 0% shows nothing built. */
export function filledColumns(fraction: number, columns: number): number {
  if (!Number.isFinite(fraction) || !(columns > 0)) return 0;
  return Math.min(columns, Math.floor(clamp(fraction, 0, 1) * columns + 1e-6));
}

/** The band of order that sweeps the columns while the total is unknown. */
export function scanContains(column: number, columns: number, seconds: number): boolean {
  if (columns < 2) return false;
  const sweep = ((seconds * SCAN_SPEED) % 1.4) - 0.2;
  return Math.abs(column / (columns - 1) - sweep) < SCAN_HALF_WIDTH;
}

/**
 * Three rows of points. Work that is done is built from the cloud: its points converge, lock
 * into the lattice with a flash and stay fixed. Work that is not done hangs as a loose cloud.
 */
export class LatticeProgressField {
  private readonly seed: number;
  private dots = new DotField(0);
  private siteX = new Float32Array(0);
  private siteY = new Float32Array(0);
  private anchorX = new Float32Array(0);
  private anchorY = new Float32Array(0);
  private column = new Uint16Array(0);
  private built = new Uint8Array(0);
  private locked = new Uint8Array(0);
  private flash = new Float32Array(0);
  private columns = 0;
  private width = 0;
  private height = 0;
  private displayed = 0;
  private target = 0;
  private mode: ProgressMode = "determinate";
  private clock = 0;
  private complete = false;

  constructor(seed = 1) {
    this.seed = seed;
  }

  get columnCount(): number {
    return this.columns;
  }

  get dotCount(): number {
    return this.dots.count;
  }

  get targetColumns(): number {
    return this.mode === "determinate" ? filledColumns(this.target, this.columns) : 0;
  }

  get solidCount(): number {
    let total = 0;
    for (let index = 0; index < this.built.length; index += 1) total += this.built[index];
    return total;
  }

  get lockedCount(): number {
    let total = 0;
    for (let index = 0; index < this.locked.length; index += 1) total += this.locked[index];
    return total;
  }

  setTarget(fraction: number): void {
    this.mode = "determinate";
    this.target = Number.isFinite(fraction) ? clamp(fraction, 0, 1) : 0;
  }

  setScanning(): void {
    this.mode = "scan";
    this.target = 0;
  }

  resize(width: number, height: number): void {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.width && nextHeight === this.height && this.columns > 0) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.columns = progressColumns(nextWidth);
    const count = this.columns * PROGRESS_ROWS;
    this.dots = new DotField(count, seededRandom(this.seed));
    this.siteX = new Float32Array(count);
    this.siteY = new Float32Array(count);
    this.anchorX = new Float32Array(count);
    this.anchorY = new Float32Array(count);
    this.column = new Uint16Array(count);
    this.built = new Uint8Array(count);
    this.locked = new Uint8Array(count);
    this.flash = new Float32Array(count);
    const pitch = nextWidth / this.columns;
    const top = (nextHeight - (PROGRESS_ROWS - 1) * PROGRESS_ROW_PITCH_PX) / 2;
    const edge = PROGRESS_SOLID_RADIUS_PX;
    for (let index = 0; index < count; index += 1) {
      const column = index % this.columns;
      const row = Math.floor(index / this.columns);
      this.column[index] = column;
      this.siteX[index] = (column + 0.5) * pitch;
      this.siteY[index] = top + row * PROGRESS_ROW_PITCH_PX;
      this.anchorX[index] = clamp(this.siteX[index] + (this.dots.seed[index] - 0.5) * pitch * GAS_SPREAD_COLUMNS, edge, nextWidth - edge);
      this.anchorY[index] = clamp(this.siteY[index] + Math.sin(index * 12.9898) * GAS_SPREAD_HEIGHT * nextHeight, edge, nextHeight - edge);
    }
    this.settle();
  }

  /** Jumps to the finished picture: built points on their sites, the rest hanging in the cloud. */
  settle(): void {
    const dots = this.dots;
    this.displayed = this.mode === "determinate" ? this.target : 0;
    const filled = filledColumns(this.displayed, this.columns);
    for (let index = 0; index < dots.count; index += 1) {
      const solid = this.mode === "determinate" && this.column[index] < filled;
      this.built[index] = solid ? 1 : 0;
      this.locked[index] = solid ? 1 : 0;
      this.flash[index] = 0;
      const x = solid ? this.siteX[index] : this.anchorX[index];
      const y = solid ? this.siteY[index] : this.anchorY[index];
      dots.place(index, x, y);
      dots.setHome(index, x, y, solid ? 1 : PROGRESS_GAS_ALPHA);
      dots.alpha[index] = dots.alphaGoal[index];
      dots.delay[index] = 0;
    }
    this.complete = this.mode === "determinate" && this.displayed >= 1;
  }

  /** Returns whether another frame is needed. `drift` lets the cloud sway; without it the cloud only settles. */
  step(seconds: number, drift = true): boolean {
    const dt = clamp(Number.isFinite(seconds) ? seconds : 0, 0, DOT_FRAME_LIMIT_SECONDS);
    this.clock += dt;
    if (this.mode === "determinate") {
      this.displayed += (this.target - this.displayed) * Math.min(1, dt * EASE_PER_SECOND);
      if (Math.abs(this.target - this.displayed) < 0.0005) this.displayed = this.target;
    }
    const dots = this.dots;
    const filled = filledColumns(this.displayed, this.columns);
    let converging = false;
    for (let index = 0; index < dots.count; index += 1) {
      if (this.isSolid(index, filled)) {
        if (!this.built[index]) {
          this.built[index] = 1;
          dots.setHome(index, this.siteX[index], this.siteY[index], 1);
          dots.delay[index] = dots.seed[index] * 0.2;
        }
        if (!this.locked[index] && Math.hypot(dots.x[index] - this.siteX[index], dots.y[index] - this.siteY[index]) < LOCK_DISTANCE_PX) {
          this.locked[index] = 1;
          this.flash[index] = 1;
        }
        if (this.locked[index]) dots.place(index, this.siteX[index], this.siteY[index]);
        else converging = true;
      } else {
        if (this.built[index]) {
          this.built[index] = 0;
          this.locked[index] = 0;
          dots.delay[index] = 0;
          dots.vx[index] = (dots.seed[index] - 0.5) * 50;
          dots.vy[index] = Math.sin(index * 78.233) * 25;
        }
        const phase = dots.seed[index] * Math.PI * 2;
        const swayX = drift ? Math.sin(this.clock * (0.6 + dots.seed[index] * 0.7) + phase) * 6 : 0;
        const swayY = drift ? Math.cos(this.clock * (0.8 + dots.seed[index] * 0.6) + phase * 1.3) * 4 : 0;
        dots.setHome(index, this.anchorX[index] + swayX, this.anchorY[index] + swayY, PROGRESS_GAS_ALPHA);
      }
    }
    const complete = this.mode === "determinate" && this.displayed >= 1;
    if (complete && !this.complete) {
      for (let index = 0; index < dots.count; index += 1) this.flash[index] = Math.max(this.flash[index], 0.6);
    }
    this.complete = complete;
    const spring = converging ? PROGRESS_LOCK_SPRING : PROGRESS_GAS_SPRING;
    dots.stiffness = spring.stiffness;
    dots.damping = spring.damping;
    dots.step(dt);
    let glowing = false;
    for (let index = 0; index < dots.count; index += 1) {
      this.flash[index] = Math.max(0, this.flash[index] - dt * FLASH_DECAY_PER_SECOND);
      if (this.flash[index] > 0) glowing = true;
    }
    return drift || converging || glowing || dots.moving() || this.displayed !== this.target;
  }

  draw(context: ProgressContext, palette: ProgressPalette): void {
    context.clearRect(0, 0, this.width, this.height);
    const dots = this.dots;
    for (let index = 0; index < dots.count; index += 1) {
      const alpha = Math.min(1, dots.alpha[index]);
      if (alpha < 0.02) continue;
      const lit = this.flash[index];
      const solid = this.built[index] === 1;
      context.globalAlpha = alpha;
      context.fillStyle = lit > FLASH_VISIBLE ? palette.flash : solid ? palette.solid : palette.gas;
      const radius = (solid ? PROGRESS_SOLID_RADIUS_PX : PROGRESS_GAS_RADIUS_PX) * (1 + lit * 0.9);
      context.beginPath();
      context.arc(dots.x[index], dots.y[index], radius, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  private isSolid(index: number, filled: number): boolean {
    return this.mode === "scan"
      ? scanContains(this.column[index], this.columns, this.clock)
      : this.column[index] < filled;
  }
}
