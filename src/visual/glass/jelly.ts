export interface SpringState {
  position: number;
  goal: number;
  velocity: number;
}

export interface SpringTuning {
  stiffness: number;
  damping: number;
}

export const defaultTuning: SpringTuning = { stiffness: 220, damping: 20 };

const longestFrame = 0.08;
const longestSubstep = 1 / 180;
const restSpeed = 0.025;
const restDistance = 0.005;
const narrowestStretch = -0.2;
const widestStretch = 0.34;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function createSpring(position = 0): SpringState {
  return { position, goal: position, velocity: 0 };
}

export function isMoving(spring: SpringState): boolean {
  return Math.abs(spring.velocity) > restSpeed || Math.abs(spring.goal - spring.position) > restDistance;
}

export function snapSpring(spring: SpringState, position = spring.goal): void {
  spring.position = position;
  spring.goal = position;
  spring.velocity = 0;
}

export function advanceSpring(spring: SpringState, seconds: number, tuning: SpringTuning = defaultTuning): void {
  const frame = clamp(seconds, 0, longestFrame);
  if (!(frame > 0)) return;
  const steps = Math.max(1, Math.ceil(frame / longestSubstep));
  const h = frame / steps;
  for (let i = 0; i < steps; i += 1) {
    const pull = (spring.goal - spring.position) * tuning.stiffness;
    spring.velocity += (pull - spring.velocity * tuning.damping) * h;
    spring.position += spring.velocity * h;
  }
  if (!isMoving(spring)) snapSpring(spring);
}

export interface StretchMatrix {
  m11: number;
  m12: number;
  m22: number;
  css: string;
}

export function stretchMatrix(amount: number, heading: number, lift = 1): StretchMatrix {
  const along = 1 + clamp(amount, narrowestStretch, widestStretch);
  const across = 1 / along;
  const mean = (along + across) / 2;
  const spread = (along - across) / 2;
  const m11 = (mean + spread * Math.cos(2 * heading)) * lift;
  const m12 = spread * Math.sin(2 * heading) * lift;
  const m22 = (mean - spread * Math.cos(2 * heading)) * lift;
  const css = `matrix(${m11.toFixed(4)}, ${m12.toFixed(4)}, ${m12.toFixed(4)}, ${m22.toFixed(4)}, 0, 0)`;
  return { m11, m12, m22, css };
}

export interface KnobPose {
  scaleX: number;
  scaleY: number;
  offset: number;
}

export function knobPose(offset: number, railLength: number, knobSize: number, pressure = 0, stretch = 0): KnobPose {
  const room = Math.min(0.18, railLength / Math.max(knobSize, 1));
  const scaleX = 1 + clamp(pressure * 0.1 + stretch, 0, room);
  const margin = ((scaleX - 1) * knobSize) / 2;
  return { scaleX, scaleY: 1 / scaleX, offset: clamp(offset, margin, Math.max(margin, railLength - margin)) };
}

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function keepInside(x: number, y: number, box: Box, viewport: { width: number; height: number }, inset = 16): { x: number; y: number } {
  return {
    x: clamp(x, inset - box.left, viewport.width - inset - box.right),
    y: clamp(y, inset - box.top, viewport.height - inset - box.bottom),
  };
}

/** Mutable wrapper around the functional spring, for components that keep one body per element. */
export class Spring {
  private readonly state: SpringState;

  constructor(position = 0) {
    this.state = createSpring(position);
  }

  get value(): number {
    return this.state.position;
  }

  set value(next: number) {
    this.state.position = next;
  }

  get target(): number {
    return this.state.goal;
  }

  set target(next: number) {
    this.state.goal = next;
  }

  get velocity(): number {
    return this.state.velocity;
  }

  set velocity(next: number) {
    this.state.velocity = next;
  }

  get moving(): boolean {
    return isMoving(this.state);
  }

  step(dt: number, stiffness = defaultTuning.stiffness, damping = defaultTuning.damping): void {
    advanceSpring(this.state, dt, { stiffness, damping });
  }

  snap(position = this.state.goal): void {
    snapSpring(this.state, position);
  }
}

export function jellyMatrix(stretch: number, angle: number, lift = 1): StretchMatrix {
  return stretchMatrix(stretch, angle, lift);
}
