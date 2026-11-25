import { createCurvatureMap, type CurvatureGeometry } from "./geometry";

export const MAX_CURVATURE_CACHE_BYTES = 4 * 1024 * 1024;
const images = new Map<string, { value: string; bytes: number }>();
const capacity = 32;
let cachedBytes = 0;

function imageBytes(value: string): number {
  return value.length * 2;
}

export function clearCurvatureMapCache() {
  images.clear();
  cachedBytes = 0;
}

export function curvatureMapCacheBytes(): number {
  return cachedBytes;
}

function curvatureMapKey(shape: CurvatureGeometry): string {
  const pose = shape.optics;
  return [shape.width, shape.height, shape.radius, shape.bevel ?? 20, shape.inset ?? 0,
    shape.refraction ?? .9, shape.dispersion ?? .65, pose?.bendX ?? 0, pose?.bendY ?? 0,
    pose?.pressure ?? 0, pose?.stretch ?? 0, pose?.heading ?? 0].join("|");
}

/** Bounded reuse across remounts; a live pose is part of the numeric field. */
export function curvatureMapImage(shape: CurvatureGeometry): string | null {
  const key = curvatureMapKey(shape);
  const cached = images.get(key);
  if (cached !== undefined) {
    images.delete(key);
    images.set(key, cached);
    return cached.value;
  }
  try {
    const map = createCurvatureMap(shape);
    const canvas = document.createElement("canvas");
    canvas.width = map.width;
    canvas.height = map.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const pixels = context.createImageData(map.width, map.height);
    pixels.data.set(map.data);
    context.putImageData(pixels, 0, 0);
    const image = canvas.toDataURL("image/png");
    const bytes = imageBytes(image);
    if (bytes <= MAX_CURVATURE_CACHE_BYTES) {
      images.set(key, { value: image, bytes });
      cachedBytes += bytes;
      while (images.size > capacity || cachedBytes > MAX_CURVATURE_CACHE_BYTES) {
        const oldestKey = images.keys().next().value;
        if (oldestKey === undefined || oldestKey === key) break;
        const oldest = images.get(oldestKey);
        images.delete(oldestKey);
        if (oldest) cachedBytes = Math.max(0, cachedBytes - oldest.bytes);
      }
    }
    return image;
  } catch {
    return null;
  }
}

/** A surface owns one asynchronous encoder, one waiting pose and bounded URLs. */
export function createLiveCurvatureMaps(onImage: (source: string, shape: CurvatureGeometry) => void) {
  type Request = { key: string; shape: CurvatureGeometry };
  const cache = new Map<string, { url: string; bytes: number }>();
  let cacheBytes = 0;
  let desired: Request | null = null;
  let encoding: Request | null = null;
  let published: string | null = null;
  let disposed = false;

  const trim = () => {
    for (const [key, entry] of cache) {
      if (cache.size <= capacity && cacheBytes <= MAX_CURVATURE_CACHE_BYTES) break;
      // The currently displayed image remains valid until its replacement lands.
      if (key === published) continue;
      cache.delete(key);
      cacheBytes = Math.max(0, cacheBytes - entry.bytes);
      URL.revokeObjectURL(entry.url);
    }
  };
  const publish = (request: Request, source: string) => {
    if (request.key === published) return;
    published = request.key;
    onImage(source, request.shape);
  };
  const start = () => {
    if (disposed || encoding || !desired) return;
    const request = desired;
    const hit = cache.get(request.key);
    if (hit !== undefined) {
      cache.delete(request.key); cache.set(request.key, hit);
      publish(request, hit.url);
      return;
    }
    encoding = request;
    const complete = (blob: Blob | null) => {
      if (disposed) return;
      encoding = null;
      if (blob) {
        let source: string | null = null;
        try { source = URL.createObjectURL(blob); } catch { /* Retain the last valid image. */ }
        if (source) {
          const bytes = Math.max(0, blob.size);
          cache.set(request.key, { url: source, bytes });
          cacheBytes += bytes;
          // A newer requested/cached pose always wins over a late completion.
          if (desired?.key === request.key) publish(desired, source);
          trim();
        }
      }
      // Failed encodes retry only on a subsequent request, never in a tight loop.
      if (desired?.key !== request.key) start();
    };
    try {
      if (typeof URL.createObjectURL !== "function") { encoding = null; return; }
      const map = createCurvatureMap(request.shape);
      const fill = (context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => {
        const pixels = context.createImageData(map.width, map.height);
        pixels.data.set(map.data); context.putImageData(pixels, 0, 0);
      };
      const fallback = () => {
        if (disposed) return;
        try {
          const canvas = document.createElement("canvas");
          if (typeof canvas.toBlob !== "function") { complete(null); return; }
          canvas.width = map.width; canvas.height = map.height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) { complete(null); return; }
          fill(context); canvas.toBlob(complete, "image/png");
        } catch { complete(null); }
      };
      if (typeof OffscreenCanvas !== "undefined") {
        try {
          const canvas = new OffscreenCanvas(map.width, map.height);
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (context && typeof canvas.convertToBlob === "function") {
            fill(context);
            void canvas.convertToBlob({ type: "image/png" }).then(complete, fallback);
            return;
          }
        } catch { /* Use the DOM encoder when this capability is unavailable. */ }
      }
      fallback();
    } catch {
      encoding = null;
    }
  };
  return {
    update(shape: CurvatureGeometry) {
      if (disposed) return;
      desired = { key: curvatureMapKey(shape), shape: { ...shape, optics: shape.optics && { ...shape.optics } } };
      const hit = cache.get(desired.key);
      if (hit !== undefined) {
        cache.delete(desired.key); cache.set(desired.key, hit);
        publish(desired, hit.url);
      } else start();
    },
    dispose() {
      disposed = true; desired = null;
      for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
      cache.clear();
      cacheBytes = 0;
    },
  };
}
