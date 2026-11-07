export interface CurvatureDomain {
  width: number;
  height: number;
  inset: number;
  radius: number;
  bendX: number;
  bendY: number;
}

type Interval = readonly [number, number];
type Differential = { value: Interval; dx: Interval; dy: Interval };
type GradientBox = { x: Interval; y: Interval };
type Cone = { all: boolean; low: number; high: number };
const tau = Math.PI * 2;
const geometryCache = new Map<string, Map<number, Cone>>();
const cachedGeometries = 8;
const cachedCellsPerGeometry = 8192;

function geometryCones(domain: CurvatureDomain, width: number, height: number) {
  const key = [domain.width, domain.height, domain.inset, domain.radius, domain.bendX, domain.bendY, width, height].join("|");
  const cones = geometryCache.get(key) ?? new Map<number, Cone>();
  geometryCache.delete(key);
  geometryCache.set(key, cones);
  if (geometryCache.size > cachedGeometries) geometryCache.delete(geometryCache.keys().next().value!);
  return cones;
}

function padded(low: number, high: number): Interval {
  const epsilon = 16 * Number.EPSILON * Math.max(1, Math.abs(low), Math.abs(high));
  return [low - epsilon, high + epsilon];
}
const add = (a: Interval, b: Interval): Interval => padded(a[0] + b[0], a[1] + b[1]);
const multiplyScalar = (a: Interval, k: number): Interval => k >= 0
  ? padded(a[0] * k, a[1] * k) : padded(a[1] * k, a[0] * k);
function multiply(a: Interval, b: Interval): Interval {
  const ll = a[0] * b[0], lh = a[0] * b[1], hl = a[1] * b[0], hh = a[1] * b[1];
  return padded(Math.min(ll, lh, hl, hh), Math.max(ll, lh, hl, hh));
}
const square = (a: Interval): Interval => padded(a[0] <= 0 && a[1] >= 0 ? 0 : Math.min(a[0] ** 2, a[1] ** 2), Math.max(a[0] ** 2, a[1] ** 2));

/** Enclose every rounded-box SDF gradient, including max/abs branch ties. */
function roundedGradient(domain: CurvatureDomain, left: number, top: number, right: number, bottom: number): GradientBox {
  let xLow = Infinity, xHigh = -Infinity, yLow = Infinity, yHigh = -Infinity;
  const include = (lx: number, hx: number, ly: number, hy: number, sx: number, sy: number) => {
    xLow = Math.min(xLow, sx > 0 ? lx : -hx); xHigh = Math.max(xHigh, sx > 0 ? hx : -lx);
    yLow = Math.min(yLow, sy > 0 ? ly : -hy); yHigh = Math.max(yHigh, sy > 0 ? hy : -ly);
  };
  const cx = domain.width / 2, cy = domain.height / 2;
  // Include both signs at a branch tie. Inside each half, absolute value
  // is monotone, so its interval endpoints are already ordered.
  for (let sx = left <= cx ? -1 : 1; sx <= (right >= cx ? 1 : -1); sx += 2) {
    const a = (sx < 0 ? cx - Math.min(right, cx) : Math.max(left, cx) - cx) - cx + domain.inset + domain.radius;
    const b = (sx < 0 ? cx - left : right - cx) - cx + domain.inset + domain.radius;
    for (let sy = top <= cy ? -1 : 1; sy <= (bottom >= cy ? 1 : -1); sy += 2) {
      const c = (sy < 0 ? cy - Math.min(bottom, cy) : Math.max(top, cy) - cy) - cy + domain.inset + domain.radius;
      const d = (sy < 0 ? cy - top : bottom - cy) - cy + domain.inset + domain.radius;
      if (c <= 0 && b >= c) include(1, 1, 0, 0, sx, sy);
      if (a <= 0 && d >= a) include(0, 0, 1, 1, sx, sy);
      if (b > 0 && d > 0) {
        const lx = Math.max(0, a), ly = Math.max(0, c);
        const xLength = Math.hypot(b, ly), yLength = Math.hypot(lx, d);
        include(lx / yLength, b / xLength, ly / xLength, d / yLength, sx, sy);
      }
    }
  }
  return { x: padded(xLow, xHigh), y: padded(yLow, yHigh) };
}
function normalizedClamp(input: Differential, halfSize: number): Differential {
  const raw = multiplyScalar(input.value, 1 / halfSize);
  const value: Interval = [Math.max(-1, Math.min(1, raw[0])), Math.max(-1, Math.min(1, raw[1]))];
  if (raw[1] < -1 || raw[0] > 1) return { value, dx: [0, 0], dy: [0, 0] };
  const slope: Interval = raw[0] > -1 && raw[1] < 1 ? [1, 1] : [0, 1];
  return { value, dx: multiply(multiplyScalar(input.dx, 1 / halfSize), slope), dy: multiply(multiplyScalar(input.dy, 1 / halfSize), slope) };
}

/** Differentiate exactly the same three inverse-bow steps as lensDistance. */
function gradientBox(domain: CurvatureDomain, left: number, top: number, right: number, bottom: number): GradientBox {
  if (!domain.bendX && !domain.bendY) return roundedGradient(domain, left, top, right, bottom);
  const px = padded(left - domain.width / 2, right - domain.width / 2);
  const py = padded(top - domain.height / 2, bottom - domain.height / 2);
  let u: Differential = { value: px, dx: [1, 1], dy: [0, 0] };
  let v: Differential = { value: py, dx: [0, 0], dy: [1, 1] };
  for (let step = 0; step < 3; step++) {
    const qx = normalizedClamp(u, domain.width / 2), qy = normalizedClamp(v, domain.height / 2);
    const ux = multiplyScalar(qy.value, 2 * domain.bendX), vy = multiplyScalar(qx.value, 2 * domain.bendY);
    u = {
      value: add(add(px, [-domain.bendX, -domain.bendX]), multiplyScalar(square(qy.value), domain.bendX)),
      dx: add([1, 1], multiply(ux, qy.dx)), dy: multiply(ux, qy.dy),
    };
    v = {
      value: add(add(py, [-domain.bendY, -domain.bendY]), multiplyScalar(square(qx.value), domain.bendY)),
      dx: multiply(vy, qx.dx), dy: add([1, 1], multiply(vy, qx.dy)),
    };
  }
  const local = roundedGradient(domain, u.value[0] + domain.width / 2, v.value[0] + domain.height / 2,
    u.value[1] + domain.width / 2, v.value[1] + domain.height / 2);
  return { x: add(multiply(local.x, u.dx), multiply(local.y, v.dx)),
    y: add(multiply(local.x, u.dy), multiply(local.y, v.dy)) };
}
function coneFor(box: GradientBox): Cone {
  if (box.x[0] <= 0 && box.x[1] >= 0 && box.y[0] <= 0 && box.y[1] >= 0)
    return { all: true, low: 0, high: tau };
  const angles = [];
  for (const x of box.x) for (const y of box.y) if (x || y) angles.push((Math.atan2(y, x) + tau) % tau);
  angles.sort((a, b) => a - b);
  let widest = -1, index = 0;
  for (let i = 0; i < angles.length; i++) {
    const gap = angles[(i + 1) % angles.length] + (i === angles.length - 1 ? tau : 0) - angles[i];
    if (gap > widest) { widest = gap; index = i; }
  }
  const low = angles[(index + 1) % angles.length];
  let high = angles[index]; if (high < low) high += tau;
  return { all: false, low: low - 1e-12, high: high + 1e-12 };
}
function quadraticMinimum(a: number, b: number, c: number, d: number, cone: Cone) {
  if (cone.all) return (a + d - Math.hypot(a - d, b + c)) / 2;
  const value = (angle: number) => {
    const x = Math.cos(angle), y = Math.sin(angle);
    return a * x * x + (b + c) * x * y + d * y * y;
  };
  let minimum = Math.min(value(cone.low), value(cone.high));
  const eigenAngle = Math.atan2(b + c, a - d) / 2;
  for (let k = Math.floor((cone.low - eigenAngle) / (Math.PI / 2)) - 1;
    k <= Math.ceil((cone.high - eigenAngle) / (Math.PI / 2)) + 1; k++) {
    const angle = eigenAngle + k * Math.PI / 2;
    if (angle >= cone.low && angle <= cone.high) minimum = Math.min(minimum, value(angle));
  }
  return minimum;
}

/**
 * Return a lower bound on normal source-coordinate derivatives of an opaque
 * 8-bit R/G displacement map under bilinear sampling with edge clamping.
 *
 * Each finite-difference component is an average of an SDF partial derivative
 * inside the cell expanded by .25px. Its interval rectangle therefore encloses
 * the actual normal direction. For any fixed direction, the bilinear Jacobian
 * is affine in x/y, so checking all four corners and the whole angular interval
 * proves the bound throughout a cell. This checks encoded bytes, not a smooth
 * approximation; each retry is independent of rounding monotonicity.
 *
 * Intervals are created lazily and reused only for exactly the same rounded
 * and warped geometry. The bounds and limits of the LRU are independent of the
 * generated map's scale and bytes. The
 * edge strips between image bounds and sample centers use one-axis derivatives;
 * the four clamped corner rectangles have constant displacement (derivative1).
 */
export function createNormalDerivativeCheck(domain: CurvatureDomain, width: number, height: number) {
  const hx = domain.width / width, hy = domain.height / height;
  const inverseX = 1 / (255 * hx), inverseY = 1 / (255 * hy);
  const count = (width - 1) * (height - 1);
  const cones = geometryCones(domain, width, height);
  const cone = (id: number, left: number, top: number, right: number, bottom: number) => {
    const cached = cones.get(id);
    if (cached) return cached;
    const value = coneFor(gradientBox(domain, left - .25, top - .25, right + .25, bottom + .25));
    if (cones.size < cachedCellsPerGeometry) cones.set(id, value);
    return value;
  };
  function measure(data: Uint8ClampedArray, maximumRgbScale: number, floor?: number) {
    let minimum = 0;
    // For the acceptance-only query, the symmetric part of the bilinear
    // Jacobian can prove a corner safe for *every* unit normal. Only the
    // ambiguous corners need their more expensive geometric interval.
    const cutoff = floor === undefined || !(maximumRgbScale > 0) ? Infinity :
      (floor - 1) / maximumRgbScale + 1e-10;
    const safeInEveryDirection = (a: number, b: number, c: number, d: number) => {
      const x = a - cutoff, y = d - cutoff, cross = (b + c) / 2;
      return x > 0 && y > 0 && x * y > cross * cross;
    };
    const failed = () => floor !== undefined && 1 + maximumRgbScale * minimum < floor;
    for (let row = 0; row < height - 1; row++) for (let col = 0; col < width - 1; col++) {
      const i = (row * width + col) * 4, right = i + 4, down = i + width * 4, corner = down + 4;
      if (data[i] === data[right] && data[i] === data[down] && data[i] === data[corner]
        && data[i + 1] === data[right + 1] && data[i + 1] === data[down + 1] && data[i + 1] === data[corner + 1]) continue;
      let interval: Cone | undefined;
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        const a = (data[i + y * width * 4 + 4] - data[i + y * width * 4]) * inverseX;
        const c = (data[i + y * width * 4 + 5] - data[i + y * width * 4 + 1]) * inverseX;
        const b = (data[i + x * 4 + width * 4] - data[i + x * 4]) * inverseY;
        const d = (data[i + x * 4 + width * 4 + 1] - data[i + x * 4 + 1]) * inverseY;
        if (safeInEveryDirection(a, b, c, d)) continue;
        interval ??= cone(row * (width - 1) + col, (col + .5) * hx, (row + .5) * hy, (col + 1.5) * hx, (row + 1.5) * hy);
        minimum = Math.min(minimum, quadraticMinimum(a, b, c, d, interval));
        if (failed()) return 1 + maximumRgbScale * minimum;
      }
    }
    for (let side = 0; side < 2; side++) {
      const col = side ? width - 1 : 0;
      for (let row = 0; row < height - 1; row++) {
        const i = (row * width + col) * 4, down = i + width * 4;
        if (data[i] === data[down] && data[i + 1] === data[down + 1]) continue;
        const interval = cone(count + side * (height - 1) + row,
          side ? domain.width - hx / 2 : 0, (row + .5) * hy,
          side ? domain.width : hx / 2, (row + 1.5) * hy);
        minimum = Math.min(minimum, quadraticMinimum(0, (data[down] - data[i]) * inverseY,
          0, (data[down + 1] - data[i + 1]) * inverseY, interval));
        if (failed()) return 1 + maximumRgbScale * minimum;
      }
      const row = side ? height - 1 : 0;
      for (let x = 0; x < width - 1; x++) {
        const i = (row * width + x) * 4;
        if (data[i] === data[i + 4] && data[i + 1] === data[i + 5]) continue;
        const interval = cone(count + 2 * (height - 1) + side * (width - 1) + x,
          (x + .5) * hx, side ? domain.height - hy / 2 : 0,
          (x + 1.5) * hx, side ? domain.height : hy / 2);
        minimum = Math.min(minimum, quadraticMinimum((data[i + 4] - data[i]) * inverseX,
          0, (data[i + 5] - data[i + 1]) * inverseX, 0, interval));
        if (failed()) return 1 + maximumRgbScale * minimum;
      }
    }
    return 1 + maximumRgbScale * minimum;
  }
  return Object.assign(
    (data: Uint8ClampedArray, scale: number) => measure(data, scale),
    { accepts: (data: Uint8ClampedArray, scale: number, floor: number) => measure(data, scale, floor) >= floor },
  );
}
