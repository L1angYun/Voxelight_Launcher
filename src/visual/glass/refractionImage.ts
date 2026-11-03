import { createCurvatureMap, type CurvatureGeometry } from "./geometry";

const images = new Map<string, string>();
const capacity = 32;

/** Bounded reuse across remounts; a live pose is part of the numeric field. */
export function curvatureMapImage(shape: CurvatureGeometry): string | null {
  const pose = shape.optics;
  const key = [shape.width, shape.height, shape.radius, shape.bevel ?? 20, shape.inset ?? 0,
    shape.refraction ?? .9, shape.dispersion ?? .65, pose?.bendX ?? 0, pose?.bendY ?? 0,
    pose?.pressure ?? 0, pose?.stretch ?? 0, pose?.heading ?? 0].join("|");
  const cached = images.get(key);
  if (cached !== undefined) {
    images.delete(key);
    images.set(key, cached);
    return cached;
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
    images.set(key, image);
    if (images.size > capacity) images.delete(images.keys().next().value!);
    return image;
  } catch {
    return null;
  }
}
