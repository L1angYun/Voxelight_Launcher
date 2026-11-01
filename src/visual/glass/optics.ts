import type { GlassOptics } from "./types";

const variables = {
  bendX: "--jelly-bend-x",
  bendY: "--jelly-bend-y",
  pressure: "--jelly-press",
  energy: "--jelly-energy",
  stretch: "--jelly-stretch",
  heading: "--jelly-heading",
} as const;

type Channel = keyof typeof variables;

const channels = Object.keys(variables) as Channel[];

function bounded(raw: string | undefined, min: number, max: number): number {
  const value = Number.parseFloat(raw ?? "");
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : 0;
}

/**
 * Reads the deformation a moving control publishes as CSS variables. Values are
 * looked up on the surface and the few wrappers around it, nearest first. A
 * surface whose control publishes nothing returns undefined, so it needs no
 * per-frame measuring.
 */
export function readGlassOptics(element: HTMLElement, reach = 4): GlassOptics | undefined {
  const raw: Partial<Record<Channel, string>> = {};
  let node: HTMLElement | null = element;
  for (let depth = 0; node && depth <= reach; depth += 1) {
    for (const channel of channels) {
      if (raw[channel] !== undefined) continue;
      const value = node.style.getPropertyValue(variables[channel]).trim();
      if (value) raw[channel] = value;
    }
    node = node.parentElement;
  }
  if (!channels.some((channel) => raw[channel] !== undefined)) return undefined;
  return {
    bendX: bounded(raw.bendX, -24, 24),
    bendY: bounded(raw.bendY, -24, 24),
    pressure: bounded(raw.pressure, 0, 1.16),
    energy: bounded(raw.energy, 0, 1),
    ...(raw.stretch !== undefined ? { stretch: bounded(raw.stretch, -0.2, 0.34) } : {}),
    ...(raw.heading !== undefined ? { heading: bounded(raw.heading, -Math.PI * 2, Math.PI * 2) } : {}),
  };
}
