import { describe, expect, it } from "vitest";
import { createNormalDerivativeCheck, type CurvatureDomain } from "./curvatureBounds";

const nav: CurvatureDomain = { width: 68, height: 44, inset: 3, radius: 19, bendX: 0, bendY: 0 };
const scale = 29.268;
function pixels(width: number, height: number, sample: (x: number, y: number) => [number, number]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4, [r, g] = sample(x, y);
    data[at] = r; data[at + 1] = g; data[at + 3] = 255;
  }
  return data;
}

// Independent point evaluation of the geometric contract. The implementation
// under test uses interval derivatives, not this finite-difference evaluator.
function distance(domain: CurvatureDomain, x: number, y: number) {
  const px = x - domain.width / 2, py = y - domain.height / 2;
  let u = px, v = py;
  for (let i = 0; i < 3; i++) {
    const qx = Math.max(-1, Math.min(1, u / (domain.width / 2)));
    const qy = Math.max(-1, Math.min(1, v / (domain.height / 2)));
    u = px - domain.bendX * (1 - qy * qy);
    v = py - domain.bendY * (1 - qx * qx);
  }
  const qx = Math.abs(u) - domain.width / 2 + domain.inset + domain.radius;
  const qy = Math.abs(v) - domain.height / 2 + domain.inset + domain.radius;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(0, qx), Math.max(0, qy)) - domain.radius;
}
function normal(domain: CurvatureDomain, x: number, y: number): [number, number] | null {
  const dx = distance(domain, x + .25, y) - distance(domain, x - .25, y);
  const dy = distance(domain, x, y + .25) - distance(domain, x, y - .25);
  const length = Math.hypot(dx, dy);
  return length > 1e-12 ? [dx / length, dy / length] : null;
}
function bilinear(data: Uint8ClampedArray, w: number, h: number, domain: CurvatureDomain, x: number, y: number) {
  const px = x / domain.width * w - .5, py = y / domain.height * h - .5;
  const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
  const output = [0, 0];
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const col = Math.max(0, Math.min(w - 1, ix + dx)), row = Math.max(0, Math.min(h - 1, iy + dy));
    const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
    for (let channel = 0; channel < 2; channel++) output[channel] += weight * (data[(row * w + col) * 4 + channel] / 255 - .5);
  }
  return output;
}
function directional(data: Uint8ClampedArray, w: number, h: number, domain: CurvatureDomain, x: number, y: number, amount = scale) {
  const n = normal(domain, x, y);
  if (!n) return null;
  const epsilon = 1e-4;
  const before = bilinear(data, w, h, domain, x - epsilon * n[0], y - epsilon * n[1]);
  const after = bilinear(data, w, h, domain, x + epsilon * n[0], y + epsilon * n[1]);
  return 1 + amount * ((after[0] - before[0]) * n[0] + (after[1] - before[1]) * n[1]) / (2 * epsilon);
}

describe("encoded curvature normal derivative certificate", () => {
  it("returns identity for any spatially constant displacement without touching bytes", () => {
    const data = pixels(3, 5, () => [207, 41]), before = new Uint8ClampedArray(data);
    expect(createNormalDerivativeCheck(nav, 3, 5)(data, scale)).toBe(1);
    expect(data).toEqual(before);
  });

  it("rejects a compressive encoded field and reports its real directional bound", () => {
    const domain = { width: 8, height: 8, inset: 0, radius: 0, bendX: 0, bendY: 0 };
    const data = pixels(2, 2, (_x, y) => [128, y === 0 ? 200 : 100]);
    const result = createNormalDerivativeCheck(domain, 2, 2)(data, 10);
    expect(result).toBeCloseTo(1 - 10 * 100 / 255 / 4, 10);
    expect(result).toBeLessThan(.5);
  });

  it("reuses geometric intervals while rechecking each new byte field", () => {
    const check = createNormalDerivativeCheck(nav, 4, 4);
    const safe = pixels(4, 4, () => [128, 128]);
    const unsafe = pixels(4, 4, (_x, y) => [128, 240 - y * 75]);
    expect(check(safe, scale)).toBe(1);
    expect(check(unsafe, scale)).toBeLessThan(.5);
    expect(check(safe, scale)).toBe(1);
  });

  it("checks clamped strips when the image has no two-dimensional cells", () => {
    const domain = { ...nav, bendX: 2.56 };
    const data = pixels(1, 4, (_x, y) => [240 - y * 75, 128]);
    const observed = directional(data, 1, 4, domain, 8, 14)!;
    const bound = createNormalDerivativeCheck(domain, 1, 4)(data, scale);
    expect(observed).toBeLessThan(1);
    expect(bound).toBeLessThanOrEqual(observed + 1e-8);
  });

  it("certifies the useful normal field instead of imposing a tangential bound", () => {
    const peak = 6.09444, bevel = 16.72;
    const data = pixels(68, 44, (col, row) => {
      const x = col + .5, y = row + .5, d = distance(nav, x, y), n = normal(nav, x, y);
      const pull = d <= 0 && d > -bevel && n ? peak / scale * (1 + d / bevel) : 0;
      return [Math.round((.5 - (n?.[0] ?? 0) * pull) * 255), Math.round((.5 - (n?.[1] ?? 0) * pull) * 255)];
    });
    const bound = createNormalDerivativeCheck(nav, 68, 44)(data, scale);
    expect(bound).toBeGreaterThanOrEqual(.5);
    expect(bound).toBeLessThan(.6);
  });

  for (const [name, domain, width, height] of [
    ["unbent", nav, 17, 11],
    ["bowed", { ...nav, bendX: 2.56, bendY: -2.56 }, 17, 11],
    ["opposite bow", { ...nav, bendX: -2.56, bendY: 2.56 }, 13, 9],
    ["medial tie", { width: 180, height: 50, inset: 3, radius: 14, bendX: 1.2, bendY: -.8 }, 45, 13],
    ["large downsampled", { width: 1400, height: 64, inset: 3, radius: 22, bendX: -2.56, bendY: -2.56 }, 64, 3],
  ] as const) it(`encloses independent dense finite-difference normals for ${name}`, () => {
    const data = pixels(width, height, (x, y) => [
      Math.round(128 + 36 * Math.sin(x * .8 + y * .3)),
      Math.round(128 + 41 * Math.cos(y * .7 - x * .2)),
    ]);
    const bound = createNormalDerivativeCheck(domain, width, height)(data, scale);
    let observed = Infinity;
    for (let row = 0; row < 31; row++) for (let col = 0; col < 41; col++) {
      const x = domain.width * (col + .317) / 41, y = domain.height * (row + .413) / 31;
      const value = directional(data, width, height, domain, x, y);
      if (value !== null) observed = Math.min(observed, value);
    }
    expect(Number.isFinite(bound)).toBe(true);
    expect(observed).toBeLessThan(1);
    expect(bound).toBeLessThanOrEqual(observed + 1e-8);
  });
});
