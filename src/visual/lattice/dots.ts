export const DOT_FRAME_LIMIT_SECONDS = 0.05;
export const DOT_SUBSTEP_SECONDS = 1 / 120;

export interface DotSpring {
  stiffness: number;
  damping: number;
}

/** A small deterministic generator, so a point field looks the same every time it is rebuilt. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Points that spring toward a home. A release delay holds a point back until its turn. */
export class DotField {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly homeX: Float32Array;
  readonly homeY: Float32Array;
  readonly alpha: Float32Array;
  readonly alphaGoal: Float32Array;
  readonly heat: Float32Array;
  readonly delay: Float32Array;
  readonly seed: Float32Array;
  stiffness = 180;
  damping = 14;

  constructor(count: number, random: () => number = Math.random) {
    this.count = Math.max(0, Math.floor(count));
    this.x = new Float32Array(this.count);
    this.y = new Float32Array(this.count);
    this.vx = new Float32Array(this.count);
    this.vy = new Float32Array(this.count);
    this.homeX = new Float32Array(this.count);
    this.homeY = new Float32Array(this.count);
    this.alpha = new Float32Array(this.count);
    this.alphaGoal = new Float32Array(this.count);
    this.heat = new Float32Array(this.count);
    this.delay = new Float32Array(this.count);
    this.seed = new Float32Array(this.count);
    for (let index = 0; index < this.count; index += 1) this.seed[index] = random();
  }

  setHome(index: number, x: number, y: number, alpha = 1): void {
    this.homeX[index] = x;
    this.homeY[index] = y;
    this.alphaGoal[index] = alpha;
  }

  place(index: number, x: number, y: number): void {
    this.x[index] = x;
    this.y[index] = y;
    this.vx[index] = 0;
    this.vy[index] = 0;
  }

  snap(): void {
    for (let index = 0; index < this.count; index += 1) {
      this.place(index, this.homeX[index], this.homeY[index]);
      this.alpha[index] = this.alphaGoal[index];
      this.delay[index] = 0;
    }
  }

  /** Spreads release delays over `total` seconds in the order of `key`, with a little jitter per point. */
  stagger(total: number, key: (index: number) => number): void {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < this.count; index += 1) {
      const value = key(index);
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    const span = Math.max(1e-6, high - low);
    for (let index = 0; index < this.count; index += 1) {
      this.delay[index] = ((key(index) - low) / span) * total * 0.7 + this.seed[index] * total * 0.3;
    }
  }

  burst(centerX: number, centerY: number, power = 260): void {
    for (let index = 0; index < this.count; index += 1) {
      const dx = this.x[index] - centerX;
      const dy = this.y[index] - centerY;
      const distance = Math.hypot(dx, dy) + 1;
      const push = power * (0.6 + this.seed[index] * 0.8);
      this.vx[index] += (dx / distance) * push;
      this.vy[index] += (dy / distance) * push;
      this.heat[index] = 1;
    }
  }

  /** Advances in fixed slices, so the path does not depend on the frame rate. Returns whether anything still moves. */
  step(seconds: number): boolean {
    if (!Number.isFinite(seconds) || seconds <= 0) return this.moving();
    let remaining = Math.min(seconds, DOT_FRAME_LIMIT_SECONDS);
    while (remaining > 1e-9) {
      const slice = Math.min(remaining, DOT_SUBSTEP_SECONDS);
      remaining -= slice;
      this.advance(slice);
    }
    return this.moving();
  }

  moving(): boolean {
    for (let index = 0; index < this.count; index += 1) {
      if (
        this.delay[index] > 0 ||
        Math.abs(this.vx[index]) + Math.abs(this.vy[index]) > 2 ||
        Math.abs(this.homeX[index] - this.x[index]) + Math.abs(this.homeY[index] - this.y[index]) > 0.3 ||
        Math.abs(this.alphaGoal[index] - this.alpha[index]) > 0.01
      ) {
        return true;
      }
    }
    return false;
  }

  private advance(dt: number): void {
    const keep = Math.exp(-this.damping * dt);
    const ease = Math.min(1, dt * 8);
    for (let index = 0; index < this.count; index += 1) {
      if (this.delay[index] > 0) {
        this.delay[index] -= dt;
        continue;
      }
      this.vx[index] = (this.vx[index] + (this.homeX[index] - this.x[index]) * this.stiffness * dt) * keep;
      this.vy[index] = (this.vy[index] + (this.homeY[index] - this.y[index]) * this.stiffness * dt) * keep;
      this.x[index] += this.vx[index] * dt;
      this.y[index] += this.vy[index] * dt;
      this.alpha[index] += (this.alphaGoal[index] - this.alpha[index]) * ease;
      this.heat[index] = Math.max(0, this.heat[index] - dt * 1.6);
    }
  }
}
