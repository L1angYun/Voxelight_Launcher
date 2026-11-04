import { lensBoundaryPath, lensChromaticScales, type CurvatureGeometry } from "./geometry";
import { createLiveCurvatureMaps, curvatureMapImage } from "./refractionImage";
import type { GlassOptics } from "./types";

const previousPose = new WeakMap<HTMLElement, string>();
const previousShape = new WeakMap<HTMLElement, CurvatureGeometry>();
const encoders = new WeakMap<HTMLElement, ReturnType<typeof createLiveCurvatureMaps>>();
const rounded = (value: number, step: number) => Math.round(value / step) * step;

export function resetSurfaceOptics(element: HTMLElement): void {
  encoders.get(element)?.dispose();
  encoders.delete(element);
  previousPose.delete(element);
  previousShape.delete(element);
  element.style.removeProperty("clip-path");
  element.style.removeProperty("--vx-lens-pressure");
}

/** The provider publishes poses; an encoded pose updates all optical layers together. */
export function syncSurfaceOptics(element: HTMLElement, shape: CurvatureGeometry, input?: GlassOptics): void {
  if (!element.querySelector("feImage[data-vx-curvature]")) return;
  const optics: GlassOptics = {
    bendX: rounded(input?.bendX ?? 0, 0.12), bendY: rounded(input?.bendY ?? 0, 0.12),
    pressure: rounded(input?.pressure ?? 0, 0.015), energy: rounded(input?.energy ?? 0, 0.02),
    stretch: rounded(input?.stretch ?? 0, 0.012), heading: rounded(input?.heading ?? 0, 0.04),
  };
  const liveShape = { ...shape, optics };
  if (input) {
    const previous = previousShape.get(element);
    if (!previous || previous.width !== shape.width || previous.height !== shape.height) {
      // A layout resize needs a complete field before paint. Pose-only frames
      // keep the existing field until the asynchronous encoder catches up.
      const source = curvatureMapImage(liveShape);
      if (source) applySurfaceOptics(element, liveShape, source);
    }
    let encoder = encoders.get(element);
    if (!encoder) {
      const current = createLiveCurvatureMaps((source, readyShape) => {
        if (encoders.get(element) === current) applySurfaceOptics(element, readyShape, source);
      });
      encoder = current;
      encoders.set(element, current);
    }
    // Even a return to the displayed pose must supersede an in-flight pose.
    encoder.update(liveShape);
    return;
  }
  if (encoders.has(element)) {
    encoders.get(element)!.dispose();
    encoders.delete(element);
    previousPose.delete(element);
  }
  if (previousPose.get(element) === JSON.stringify(liveShape)) return;
  const source = curvatureMapImage(liveShape);
  if (!source) return;
  applySurfaceOptics(element, liveShape, source);
}

function applySurfaceOptics(element: HTMLElement, liveShape: CurvatureGeometry, source: string): void {
  const image = element.querySelector<SVGFEImageElement>("feImage[data-vx-curvature]");
  if (!image) return;
  const key = JSON.stringify(liveShape);
  if (previousPose.get(element) === key) return;
  const optics = liveShape.optics!;
  image.setAttribute("href", source);
  const path = lensBoundaryPath(liveShape);
  element.style.clipPath = `path("${path}")`;
  for (const contour of element.querySelectorAll<SVGPathElement>("[data-vx-contour]")) contour.setAttribute("d", path);
  const scales = lensChromaticScales(optics.pressure, optics.stretch, liveShape.refraction, liveShape.dispersion);
  element.querySelectorAll<SVGFEDisplacementMapElement>("[data-vx-channel]").forEach((channel) => {
    channel.setAttribute("scale", scales[Number(channel.dataset.vxChannel)].toFixed(3));
  });
  const reflection = element.querySelector<SVGLinearGradientElement>("[data-vx-reflection]");
  reflection?.setAttribute("x1", `${12 + optics.bendX * 2}%`);
  reflection?.setAttribute("y1", `${-8 + optics.bendY * 2}%`);
  reflection?.setAttribute("x2", `${88 - optics.bendX}%`);
  reflection?.setAttribute("y2", "108%");
  element.style.setProperty("--vx-lens-pressure", optics.pressure.toFixed(3));
  element.dataset.lensOpticsEpoch = String(Number(element.dataset.lensOpticsEpoch ?? 0) + 1);
  previousPose.set(element, key);
  previousShape.set(element, liveShape);
}
