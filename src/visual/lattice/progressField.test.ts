import { describe, expect, it } from "vitest";
import {
  filledColumns,
  LatticeProgressField,
  progressColumns,
  scanContains,
  type ProgressContext,
} from "./progressField";

const palette = { gas: "gas", solid: "solid", flash: "flash" };

function recorder() {
  const arcs: { x: number; y: number; radius: number; fill: string; alpha: number }[] = [];
  const context: ProgressContext = {
    fillStyle: "",
    globalAlpha: 1,
    clearRect() {},
    beginPath() {},
    arc(x, y, radius) {
      arcs.push({ x, y, radius, fill: String(context.fillStyle), alpha: context.globalAlpha });
    },
    fill() {},
  };
  return { context, arcs };
}

function build(fraction: number, width = 300) {
  const field = new LatticeProgressField(3);
  field.resize(width, 32);
  field.setTarget(fraction);
  field.settle();
  return field;
}

function run(field: LatticeProgressField, seconds: number) {
  for (let frame = 0; frame < seconds * 60; frame += 1) field.step(1 / 60);
}

describe("progress point field", () => {
  it("packs about one column per seven pixels within a bounded range", () => {
    expect(progressColumns(300)).toBe(42);
    expect(progressColumns(40)).toBe(10);
    expect(progressColumns(100000)).toBe(240);
    expect(progressColumns(Number.NaN)).toBe(10);
  });

  it("builds a column only when its whole share is done", () => {
    expect(filledColumns(0, 40)).toBe(0);
    expect(filledColumns(1, 40)).toBe(40);
    expect(filledColumns(0.5, 42)).toBe(21);
    expect(filledColumns(0.999, 40)).toBe(39);
    expect(filledColumns(2, 40)).toBe(40);
    expect(filledColumns(-1, 40)).toBe(0);
    expect(filledColumns(Number.NaN, 40)).toBe(0);
  });

  it("sweeps a band across the columns while the total is unknown", () => {
    const lit = (seconds: number) =>
      Array.from({ length: 40 }, (_, column) => scanContains(column, 40, seconds)).filter(Boolean).length;
    expect(lit(0)).toBe(0);
    expect(lit(1.5556)).toBeGreaterThan(5);
    expect(lit(1.5556)).toBeLessThan(14);
  });

  it("shows exactly the finished share as built points", () => {
    expect(build(0.5).dotCount).toBe(126);
    expect(build(0.5).solidCount).toBe(63);
    expect(build(0.5).lockedCount).toBe(63);
    expect(build(0.5).targetColumns).toBe(21);
    expect(build(0).solidCount).toBe(0);
    expect(build(1).solidCount).toBe(126);
    expect(build(Number.NaN).solidCount).toBe(0);
  });

  it("builds new columns from the cloud and melts them back when progress drops", () => {
    const field = build(0);
    field.setTarget(0.5);
    run(field, 5);
    expect(field.solidCount).toBe(63);
    expect(field.lockedCount).toBe(63);
    field.setTarget(0.25);
    run(field, 3);
    expect(field.solidCount).toBe(30);
    expect(field.lockedCount).toBe(30);
  });

  it("keeps asking for frames while the cloud drifts and stops when it is frozen", () => {
    const field = build(0.5);
    expect(field.step(1 / 60, true)).toBe(true);
    run(field, 3);
    let needsFrame = true;
    for (let frame = 0; frame < 600 && needsFrame; frame += 1) needsFrame = field.step(1 / 60, false);
    expect(needsFrame).toBe(false);
  });

  it("scans without claiming any finished work", () => {
    const field = build(0.5);
    field.setScanning();
    field.settle();
    expect(field.solidCount).toBe(0);
    expect(field.targetColumns).toBe(0);
    let most = 0;
    for (let frame = 0; frame < 150; frame += 1) {
      field.step(1 / 60);
      most = Math.max(most, field.solidCount);
    }
    expect(most).toBeGreaterThan(0);
  });

  it("draws built points solid and the rest as a dim cloud inside the field", () => {
    const field = build(0.5);
    const { context, arcs } = recorder();
    field.draw(context, palette);
    expect(arcs).toHaveLength(126);
    const solid = arcs.filter((arc) => arc.fill === "solid");
    const gas = arcs.filter((arc) => arc.fill === "gas");
    expect(solid).toHaveLength(63);
    expect(gas).toHaveLength(63);
    expect(solid.every((arc) => arc.radius === 1.5 && arc.alpha === 1)).toBe(true);
    expect(gas.every((arc) => arc.radius === 1.25 && Math.abs(arc.alpha - 0.34) < 0.01)).toBe(true);
    expect(arcs.every((arc) => arc.x >= 0 && arc.x <= 300 && arc.y >= 0 && arc.y <= 32)).toBe(true);
    expect(context.globalAlpha).toBe(1);
  });

  it("flashes a point the moment it locks", () => {
    const field = build(0);
    field.setTarget(1);
    let flashed = false;
    for (let frame = 0; frame < 300 && !flashed; frame += 1) {
      field.step(1 / 60);
      const { context, arcs } = recorder();
      field.draw(context, palette);
      flashed = arcs.some((arc) => arc.fill === "flash");
    }
    expect(flashed).toBe(true);
  });
});
