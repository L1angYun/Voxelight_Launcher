import { lensBoundaryPath, lensChromaticScales, type CurvatureGeometry } from "./geometry";
import { curvatureMapImage } from "./refractionImage";
import type { GlassOptics } from "./types";

const previousPose = new WeakMap<HTMLElement, string>();
const rounded = (value: number, step: number) => Math.round(value / step) * step;

export function resetSurfaceOptics(element: HTMLElement): void {
  previousPose.delete(element);
  element.style.removeProperty("clip-path");
  element.style.removeProperty("--vx-lens-pressure");
}

/** The provider's existing frame prepares all optical layers from one pose. */
export function syncSurfaceOptics(element: HTMLElement, shape: CurvatureGeometry, input?: GlassOptics): void {
  const image = element.querySelector<SVGFEImageElement>("feImage[data-vx-curvature]");
  if (!image) return;
  const optics: GlassOptics = {
    bendX: rounded(input?.bendX ?? 0, 0.12), bendY: rounded(input?.bendY ?? 0, 0.12),
    pressure: rounded(input?.pressure ?? 0, 0.015), energy: rounded(input?.energy ?? 0, 0.02),
    stretch: rounded(input?.stretch ?? 0, 0.012), heading: rounded(input?.heading ?? 0, 0.04),
  };
  const key = JSON.stringify([shape.width, shape.height, shape.radius, shape.inset, shape.bevel, shape.refraction, shape.dispersion, optics]);
  if (previousPose.get(element) === key) return;
  const liveShape = { ...shape, optics };
  const source = curvatureMapImage(liveShape);
  if (!source) return;
  image.setAttribute("href", source);
  const path = lensBoundaryPath(liveShape);
  element.style.clipPath = `path("${path}")`;
  for (const contour of element.querySelectorAll<SVGPathElement>("[data-vx-contour]")) contour.setAttribute("d", path);
  const scales = lensChromaticScales(optics.pressure, optics.stretch, shape.refraction, shape.dispersion);
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
}
