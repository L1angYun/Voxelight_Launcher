import { describe, expect, it } from "vitest";
import { DotField, seededRandom } from "./dots";

function field(count: number, seed = 1) {
  return new DotField(count, seededRandom(seed));
}

describe("dot field", () => {
  it("repeats for one seed and stays inside 0..1", () => {
    const first = seededRandom(7);
    const second = seededRandom(7);
    const draws = Array.from({ length: 64 }, () => first());
    expect(draws).toEqual(Array.from({ length: 64 }, () => second()));
    expect(draws.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(draws).size).toBeGreaterThan(60);
  });

  it("springs points onto their homes and comes to rest", () => {
    const points = field(3);
    points.setHome(0, 10, 4);
    points.setHome(1, -6, 2);
    for (let frame = 0; frame < 300; frame += 1) points.step(1 / 60);
    expect(points.x[0]).toBeCloseTo(10, 1);
    expect(points.y[0]).toBeCloseTo(4, 1);
    expect(points.x[1]).toBeCloseTo(-6, 1);
    expect(points.x[2]).toBeCloseTo(0, 5);
    expect(points.moving()).toBe(false);
  });

  it("takes the same path at any frame rate", () => {
    const slow = field(2);
    const fast = field(2);
    for (const points of [slow, fast]) {
      points.setHome(0, 12, 0);
      points.setHome(1, 0, -9);
    }
    for (let frame = 0; frame < 20; frame += 1) slow.step(1 / 30);
    for (let frame = 0; frame < 80; frame += 1) fast.step(1 / 120);
    expect(slow.x[0]).toBeCloseTo(fast.x[0], 3);
    expect(slow.y[1]).toBeCloseTo(fast.y[1], 3);
  });

  it("holds a delayed point until its release time", () => {
    const points = field(1);
    points.setHome(0, 20, 0);
    points.delay[0] = 0.2;
    for (let frame = 0; frame < 6; frame += 1) points.step(1 / 60);
    expect(points.x[0]).toBe(0);
    for (let frame = 0; frame < 30; frame += 1) points.step(1 / 60);
    expect(points.x[0]).toBeGreaterThan(1);
  });

  it("ignores empty frames and caps a long stall to one short step", () => {
    const points = field(1);
    points.setHome(0, 20, 0);
    points.step(Number.NaN);
    points.step(-1);
    points.step(0);
    expect(points.x[0]).toBe(0);
    points.step(5);
    expect(points.x[0]).toBeGreaterThan(0);
    expect(points.x[0]).toBeLessThan(6);
  });

  it("pushes points away from a burst and heats them", () => {
    const points = field(1);
    points.place(0, 5, 0);
    points.burst(0, 0, 100);
    expect(points.vx[0]).toBeGreaterThan(40);
    expect(points.vy[0]).toBeCloseTo(0, 5);
    expect(points.heat[0]).toBe(1);
  });

  it("staggers release by the chosen key", () => {
    const points = field(4);
    points.stagger(0.4, (index) => index);
    expect(points.delay[0]).toBeLessThan(points.delay[3]);
    expect(Math.max(...points.delay)).toBeLessThanOrEqual(0.4 + 1e-6);
  });
});
