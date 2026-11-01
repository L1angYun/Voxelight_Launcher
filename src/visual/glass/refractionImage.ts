import { createCurvatureMap, type CurvatureGeometry } from "./geometry";

/** Only called after geometry changes; this canvas stores numeric offsets. */
export function curvatureMapImage(shape: CurvatureGeometry): string | null {
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
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
