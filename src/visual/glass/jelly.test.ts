import { describe, expect, it } from "vitest";
import { advanceSpring, createSpring, isMoving, keepInside, knobPose, stretchMatrix } from "./jelly";

function peakOf(framesPerSecond: number): number {
  const spring = createSpring(0);
  spring.goal = 1;
  let peak = 0;
  for (let i = 0; i < framesPerSecond * 4; i += 1) {
    advanceSpring(spring, 1 / framesPerSecond);
    peak = Math.max(peak, spring.position);
  }
  return peak;
}

describe("spring", () => {
  it("settles on its goal with a slight overshoot", () => {
    const spring = createSpring(0);
    spring.goal = 1;
    let peak = 0;
    for (let i = 0; i < 240; i += 1) {
      advanceSpring(spring, 1 / 60);
      peak = Math.max(peak, spring.position);
    }
    expect(peak).toBeGreaterThan(1.03);
    expect(peak).toBeLessThan(1.09);
    expect(spring.position).toBe(1);
    expect(isMoving(spring)).toBe(false);
  });

  it("behaves the same at different frame rates", () => {
    expect(Math.abs(peakOf(30) - peakOf(120))).toBeLessThan(0.01);
  });

  it("keeps its velocity when the goal changes mid-flight", () => {
    const spring = createSpring(0);
    spring.goal = 1;
    for (let i = 0; i < 6; i += 1) advanceSpring(spring, 1 / 60);
    const velocity = spring.velocity;
    spring.goal = 0;
    expect(spring.velocity).toBe(velocity);
    expect(velocity).toBeGreaterThan(0);
  });

  it("ignores a non-positive or non-finite frame time", () => {
    const spring = createSpring(0);
    spring.goal = 1;
    advanceSpring(spring, Number.NaN);
    advanceSpring(spring, -1);
    expect(spring.position).toBe(0);
  });

  it("clamps a long frame so a refocused window cannot explode", () => {
    const spring = createSpring(0);
    spring.goal = 1;
    advanceSpring(spring, 5);
    expect(Math.abs(spring.position)).toBeLessThan(2);
  });
});

describe("stretch matrix", () => {
  it("preserves area apart from lift and clamps the stretch", () => {
    const plain = stretchMatrix(0.2, 0.4);
    expect(plain.m11 * plain.m22 - plain.m12 * plain.m12).toBeCloseTo(1, 6);
    const lifted = stretchMatrix(0.2, 0.4, 1.1);
    expect(lifted.m11 * lifted.m22 - lifted.m12 * lifted.m12).toBeCloseTo(1.21, 6);
    expect(stretchMatrix(5, 0).m11).toBeCloseTo(1.34, 6);
    expect(stretchMatrix(-5, 0).m11).toBeCloseTo(0.8, 6);
  });

  it("stretches along the heading and compresses across it", () => {
    const vertical = stretchMatrix(0.3, Math.PI / 2);
    expect(vertical.m22).toBeGreaterThan(1);
    expect(vertical.m11).toBeLessThan(1);
  });
});

describe("knob pose and drag bounds", () => {
  it("never lets a stretched knob leave the rail", () => {
    const pose = knobPose(0, 30, 30, 1, 0.5);
    expect(pose.scaleX).toBeLessThanOrEqual(1.18);
    expect(pose.scaleX * pose.scaleY).toBeCloseTo(1, 6);
    expect(pose.offset).toBeGreaterThanOrEqual(((pose.scaleX - 1) * 30) / 2);
  });

  it("keeps a dragged box 16px inside the viewport", () => {
    const box = { left: 0, right: 100, top: 0, bottom: 50 };
    const result = keepInside(-500, 900, box, { width: 400, height: 300 });
    expect(result.x).toBe(16);
    expect(result.y).toBe(300 - 16 - 50);
  });
});
